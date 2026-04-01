/**
 * Clive Desktop Launcher
 *
 * Combined server that:
 *   1. Starts the host pipeline (WebSocket + STT + TTS + OpenClaw)
 *   2. Serves the UI on the same port
 *
 * Replaces the need for separate pi-client and host-server processes.
 * Designed for a local desktop with GPU (Windows or Linux).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { MessageType, CliveState, createMessage, parseMessage } = require('../shared/schemas/messages');

// Import host pipeline modules
const { transcribe, initPersistentSTT, shutdownSTT } = require('../host-server/src/stt/whisper');
const { speak, speakCached, initTTS, shutdownTTS } = require('../host-server/src/tts/elevenlabs');
const { getResponse } = require('../host-server/src/personality/engine');
const { executeTurn, getAgentRuntimeStatus } = require('../host-server/src/agent/openclaw');

const PORT = process.env.HOST_PORT || 3100;
const FALLBACK_TO_LOCAL_LLM = process.env.CLIVE_FALLBACK_TO_LOCAL_LLM !== '0';
const UI_DIR = path.join(__dirname, '../pi-client/public');

const hostRuntimeStatus = {
  activeState: CliveState.IDLE,
  connectedClients: 0,
  lastWakeWordAt: null,
  lastTranscript: '',
  lastResponse: '',
  lastTaskStatus: '',
  lastTaskProgress: '',
  platform: 'desktop',
};

// ---- MIME types for static file serving ----

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---- HTTP Server (static files + API) ----

const server = http.createServer((req, res) => {
  // API endpoints
  if (req.url === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      host: hostRuntimeStatus,
      agent: getAgentRuntimeStatus(),
      config: {
        fallbackToLocalLlm: FALLBACK_TO_LOCAL_LLM,
        platform: 'desktop',
        gpu: process.env.CSM_DEVICE || process.env.WHISPER_DEVICE || 'cpu',
      },
      timestamp: Date.now(),
    }));
    return;
  }

  // Static file serving
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Strip query strings
  filePath = filePath.split('?')[0];
  const fullPath = path.join(UI_DIR, filePath);

  // Security: prevent directory traversal
  if (!fullPath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ---- WebSocket Server ----

const wss = new WebSocketServer({ server });
const clients = new Set();
const audioBuffers = new Map();
const turnState = new Map();

wss.on('connection', (ws) => {
  console.log('[Desktop] Client connected');
  clients.add(ws);
  hostRuntimeStatus.connectedClients = clients.size;
  audioBuffers.set(ws, []);
  turnState.set(ws, { turnId: 0, cancelledTurnId: null });

  ws.send(createMessage(MessageType.STATE_CHANGE, { state: CliveState.IDLE }));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const chunks = audioBuffers.get(ws);
      if (chunks) chunks.push(buffer);
      return;
    }

    const msg = parseMessage(data.toString());
    await handleClientMessage(ws, msg);
  });

  ws.on('close', () => {
    console.log('[Desktop] Client disconnected');
    clients.delete(ws);
    hostRuntimeStatus.connectedClients = clients.size;
    audioBuffers.delete(ws);
    turnState.delete(ws);
  });

  ws.on('error', (e) => {
    console.error('[Desktop] Client error:', e.message);
  });
});

// ---- Message Handling ----

async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case MessageType.WAKE_WORD_DETECTED:
      await handleWakeWord(ws);
      break;
    case MessageType.PRESS_TO_TALK_START:
      handlePTTStart(ws);
      break;
    case MessageType.PRESS_TO_TALK_END:
      await handlePTTEnd(ws);
      break;
    case MessageType.CONFIRMATION_RESPONSE:
      handleConfirmation(ws, msg.payload);
      break;
    case MessageType.CANCEL:
      handleCancel(ws);
      break;
    default:
      console.log('[Desktop] Unknown message:', msg.type);
  }
}

// ---- Wake Word Flow ----

async function handleWakeWord(ws) {
  console.log('[Desktop] Wake word detected');
  hostRuntimeStatus.lastWakeWordAt = Date.now();
  sendState(ws, CliveState.LISTENING);
  const wakePhrase = pickRandom(['Yes?', 'Go ahead.', 'Listening.']);
  await speakCached(ws, wakePhrase);
  audioBuffers.set(ws, []);
}

// ---- Push-to-Talk Flow ----

function handlePTTStart(ws) {
  console.log('[Desktop] PTT start');
  beginTurn(ws);
  sendState(ws, CliveState.LISTENING);
  audioBuffers.set(ws, []);
}

async function handlePTTEnd(ws) {
  console.log('[Desktop] PTT end — processing audio');
  const activeTurnId = getActiveTurnId(ws);
  sendState(ws, CliveState.THINKING);

  const chunks = audioBuffers.get(ws) || [];
  audioBuffers.set(ws, []);

  if (chunks.length === 0) {
    console.log('[Desktop] No audio received');
    if (process.env.MOCK_STT === '1' || process.env.MOCK_STT === 'true') {
      chunks.push(Buffer.alloc(0));
    } else {
      sendState(ws, CliveState.IDLE);
      return;
    }
  }

  try {
    const audioBuffer = Buffer.concat(chunks);

    // 1. Transcribe
    const transcript = await transcribe(audioBuffer);
    console.log(`[Desktop] Transcript: "${transcript}"`);
    hostRuntimeStatus.lastTranscript = transcript;

    if (isTurnCancelled(ws, activeTurnId)) {
      sendState(ws, CliveState.IDLE);
      return;
    }

    if (!transcript || transcript.trim().length === 0) {
      ws.send(createMessage(MessageType.RESPONSE_TEXT, { text: "I didn't catch that. Try again?" }));
      await speakCached(ws, "I didn't catch that. Try again?");
      sendState(ws, CliveState.IDLE);
      return;
    }

    ws.send(createMessage(MessageType.TRANSCRIPT, { text: transcript }));

    // 2. Get response from OpenClaw
    console.log('[Desktop] Routing to OpenClaw...');
    const result = await executeTurn(ws, transcript);

    if (isTurnCancelled(ws, activeTurnId)) {
      sendState(ws, CliveState.IDLE);
      return;
    }

    let responseText = result.text;

    if (!result.success && FALLBACK_TO_LOCAL_LLM) {
      console.log('[Desktop] OpenClaw unavailable — using fallback');
      responseText = await getResponse(transcript);
    }

    if (!responseText || responseText.trim().length === 0) {
      responseText = "That didn't work. Want me to try again?";
    }

    console.log(`[Desktop] Response: "${responseText}"`);
    hostRuntimeStatus.lastResponse = responseText;

    // Smart response splitting for long/listy content
    const { spokenText, displayText, isLong } = splitResponse(responseText);

    if (isLong) {
      ws.send(createMessage(MessageType.RESPONSE_TEXT, { text: spokenText }));
      ws.send(createMessage('response_display', { text: displayText, summary: spokenText }));
      sendState(ws, CliveState.SPEAKING);
      await speak(ws, spokenText);
    } else {
      ws.send(createMessage(MessageType.RESPONSE_TEXT, { text: responseText }));
      sendState(ws, CliveState.SPEAKING);
      await speak(ws, responseText);
    }

    sendState(ws, CliveState.IDLE);
  } catch (e) {
    console.error('[Desktop] Pipeline error:', e);
    ws.send(createMessage(MessageType.ERROR, { error: 'Something went wrong. Try again?' }));
    sendState(ws, CliveState.ERROR);
    setTimeout(() => sendState(ws, CliveState.IDLE), 3000);
  }
}

// ---- Confirmation Flow ----

function handleConfirmation(ws, payload) {
  console.log(`[Desktop] Confirmation: ${payload.confirmed}`);
  sendState(ws, CliveState.IDLE);
}

function handleCancel(ws) {
  console.log('[Desktop] Cancelled');
  cancelActiveTurn(ws);
  audioBuffers.set(ws, []);
  sendState(ws, CliveState.IDLE);
}

// ---- Helpers ----

function sendState(ws, state) {
  hostRuntimeStatus.activeState = state;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(createMessage(MessageType.STATE_CHANGE, { state }));
  }
}

function beginTurn(ws) {
  const current = turnState.get(ws) || { turnId: 0, cancelledTurnId: null };
  const next = { turnId: current.turnId + 1, cancelledTurnId: null };
  turnState.set(ws, next);
  return next.turnId;
}

function getActiveTurnId(ws) {
  return (turnState.get(ws) || { turnId: 0 }).turnId;
}

function cancelActiveTurn(ws) {
  const current = turnState.get(ws) || { turnId: 0, cancelledTurnId: null };
  current.cancelledTurnId = current.turnId;
  turnState.set(ws, current);
}

function isTurnCancelled(ws, turnId) {
  const current = turnState.get(ws);
  return !!current && current.cancelledTurnId === turnId;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Smart Response Splitting ----

function splitResponse(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const charCount = text.length;
  const listLines = lines.filter(l => /^\s*[-*•]\s|^\s*\d+[.)]\s|^\*\*/.test(l.trim()));
  const hasLongList = listLines.length >= 4;
  const isVeryLong = charCount > 400;

  if (!hasLongList && !isVeryLong) {
    return { spokenText: text, displayText: text, isLong: false };
  }

  let spokenText = '';
  const firstListIdx = lines.findIndex(l => /^\s*[-*•]\s|^\s*\d+[.)]\s|^\*\*/.test(l.trim()));

  if (firstListIdx > 0) {
    const introLines = lines.slice(0, firstListIdx);
    spokenText = introLines.join(' ').trim();
  }

  if (!spokenText || spokenText.length < 20) {
    const itemCount = listLines.length || lines.length;
    const category = detectCategory(text);
    spokenText = `There are ${itemCount} items${category ? ` across ${category}` : ''}. I've put the full list on your screen so you can browse it.`;
  } else {
    spokenText += ` I've put the full details on your screen.`;
  }

  return { spokenText, displayText: text, isLong: true };
}

function detectCategory(text) {
  const lower = text.toLowerCase();
  if (lower.includes('skill')) return 'several categories of skills';
  if (lower.includes('file') || lower.includes('folder')) return 'files and folders';
  if (lower.includes('api') || lower.includes('endpoint')) return 'API endpoints';
  if (lower.includes('setting') || lower.includes('config')) return 'settings';
  if (lower.includes('step') || lower.includes('instruction')) return 'steps';
  return '';
}

// ---- Cloudflare Tunnel ----

const CLOUDFLARED_BIN = path.join(__dirname, '../cloudflared.exe');
const TUNNEL_ENABLED = process.env.CLOUDFLARE_TUNNEL !== '0' && fs.existsSync(CLOUDFLARED_BIN);
let tunnelProcess = null;

function startTunnel() {
  if (!TUNNEL_ENABLED) {
    console.log('[Tunnel] Disabled or cloudflared not found');
    return;
  }

  console.log('[Tunnel] Starting Cloudflare tunnel → clive.michaelproctor.co');
  tunnelProcess = spawn(CLOUDFLARED_BIN, ['tunnel', 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnelProcess.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[Tunnel] ${line}`);
  });

  tunnelProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[Tunnel] ${line}`);
  });

  tunnelProcess.on('error', (e) => {
    console.error('[Tunnel] Failed to start:', e.message);
  });

  tunnelProcess.on('exit', (code) => {
    console.log(`[Tunnel] Exited with code ${code}`);
    tunnelProcess = null;
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    console.log('[Tunnel] Stopping...');
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
  }
}

// ---- Startup ----

async function start() {
  console.log('[Desktop] Clive Desktop starting...');
  console.log(`[Desktop] Platform: ${process.platform}`);
  console.log(`[Desktop] GPU config: STT=${process.env.WHISPER_DEVICE || 'cpu'}, TTS=${process.env.CSM_ENABLED === '1' ? 'CSM (GPU)' : 'cloud/local'}`);

  // Initialize persistent GPU services if configured
  if (process.env.WHISPER_PERSISTENT === '1') {
    console.log('[Desktop] Starting persistent Whisper server...');
    try {
      await initPersistentSTT();
      console.log('[Desktop] Whisper server ready');
    } catch (e) {
      console.error('[Desktop] Whisper server failed to start:', e.message);
      console.log('[Desktop] Falling back to per-call Whisper');
    }
  }

  if (process.env.CSM_ENABLED === '1') {
    console.log('[Desktop] Starting CSM voice engine...');
    try {
      await initTTS();
      console.log('[Desktop] CSM voice engine ready');
    } catch (e) {
      console.error('[Desktop] CSM engine failed to start:', e.message);
      console.log('[Desktop] Falling back to ElevenLabs/Piper');
    }
  }

  server.listen(PORT, () => {
    console.log(`[Desktop] Clive running at http://localhost:${PORT}`);
    console.log('[Desktop] Open that URL in your browser');

    // Start tunnel after server is listening
    startTunnel();
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Desktop] Shutting down...');
  stopTunnel();
  try {
    await shutdownSTT();
    await shutdownTTS();
  } catch {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopTunnel();
  try {
    await shutdownSTT();
    await shutdownTTS();
  } catch {}
  process.exit(0);
});

start();
