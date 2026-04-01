/**
 * Clive Host Server
 *
 * Runs on the MacBook (or future Windows host).
 * Manages the full pipeline:
 *   WebSocket server <-> STT <-> OpenClaw <-> TTS <-> back to Pi
 *
 * Also serves as the WebSocket endpoint that the Pi browser UI connects to directly.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), override: true });

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { MessageType, CliveState, createMessage, parseMessage } = require('../../shared/schemas/messages');
const { transcribe } = require('./stt/whisper');
const { speak, speakCached, initTTS, shutdownTTS } = require('./tts/elevenlabs');
const { getResponse } = require('./personality/engine');
const { executeTurn, getAgentRuntimeStatus } = require('./agent/openclaw');
const { addTurn, getRecentTurns, SPEAKER_CLIVE, SPEAKER_USER } = require('./context/conversation-buffer');
const { shapeResponse } = require('./context/response-shaper');

const PORT = process.env.HOST_PORT || 3100;
const FALLBACK_TO_LOCAL_LLM = process.env.CLIVE_FALLBACK_TO_LOCAL_LLM !== '0';
const hostRuntimeStatus = {
  activeState: CliveState.IDLE,
  connectedClients: 0,
  lastWakeWordAt: null,
  lastTranscript: '',
  lastResponse: '',
  lastTaskStatus: '',
  lastTaskProgress: '',
};

// ---- HTTP + WebSocket Server ----

const server = http.createServer((req, res) => {
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
        wakeWordConfigured: !!process.env.PICOVOICE_ACCESS_KEY || !!process.env.PORCUPINE_KEYWORD_PATH,
      },
      timestamp: Date.now(),
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Clive Host Server');
});

const wss = new WebSocketServer({ server });

// Track connected clients
const clients = new Set();

// Audio buffer per client session
const audioBuffers = new Map();
const turnState = new Map();

wss.on('connection', (ws) => {
  console.log('[Host] Client connected');
  clients.add(ws);
  hostRuntimeStatus.connectedClients = clients.size;
  audioBuffers.set(ws, []);
  turnState.set(ws, { turnId: 0, cancelledTurnId: null });

  // Send initial state
  ws.send(createMessage(MessageType.STATE_CHANGE, { state: CliveState.IDLE }));

  ws.on('message', async (data, isBinary) => {
    // Binary data = audio chunk
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const chunks = audioBuffers.get(ws);
      if (chunks) chunks.push(buffer);
      return;
    }

    // JSON text message
    const msg = parseMessage(data.toString());
    await handleClientMessage(ws, msg);
  });

  ws.on('close', () => {
    console.log('[Host] Client disconnected');
    clients.delete(ws);
    hostRuntimeStatus.connectedClients = clients.size;
    audioBuffers.delete(ws);
    turnState.delete(ws);
  });

  ws.on('error', (e) => {
    console.error('[Host] Client error:', e.message);
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
      console.log('[Host] Unknown message:', msg.type);
  }
}

// ---- Wake Word Flow ----

async function handleWakeWord(ws) {
  console.log('[Host] Wake word detected');
  hostRuntimeStatus.lastWakeWordAt = Date.now();

  // Immediately acknowledge with state change
  sendState(ws, CliveState.LISTENING);

  // Play a short wake response
  const wakePhrase = pickRandom(['Yes?', 'Go ahead.', 'Listening.']);
  await speakCached(ws, wakePhrase);

  // Now waiting for audio input (PTT or continuous)
  // Audio will arrive as binary chunks
  audioBuffers.set(ws, []);
}

// ---- Push-to-Talk Flow ----

function handlePTTStart(ws) {
  console.log('[Host] PTT start');
  beginTurn(ws);
  sendState(ws, CliveState.LISTENING);
  audioBuffers.set(ws, []);
}

async function handlePTTEnd(ws) {
  console.log('[Host] PTT end — processing audio');
  const activeTurnId = getActiveTurnId(ws);
  sendState(ws, CliveState.THINKING);

  const chunks = audioBuffers.get(ws) || [];
  audioBuffers.set(ws, []);

  if (chunks.length === 0) {
    console.log('[Host] No audio received');
    sendState(ws, CliveState.IDLE);
    return;
  }

  try {
    // Combine audio chunks
    const audioBuffer = Buffer.concat(chunks);

    // 1. Transcribe
    const transcript = await transcribe(audioBuffer);
    console.log(`[Host] Transcript: "${transcript}"`);
    hostRuntimeStatus.lastTranscript = transcript;

    // Save user audio + transcript to conversation buffer (for CSM context)
    addTurn(SPEAKER_USER, transcript, audioBuffer);

    if (isTurnCancelled(ws, activeTurnId)) {
      console.log(`[Host] Turn ${activeTurnId} cancelled during transcription`);
      sendState(ws, CliveState.IDLE);
      return;
    }

    if (!transcript || transcript.trim().length === 0) {
      ws.send(createMessage(MessageType.RESPONSE_TEXT, { text: "I didn't catch that. Try again?" }));
      await speakCached(ws, "I didn't catch that. Try again?");
      sendState(ws, CliveState.IDLE);
      return;
    }

    // Send transcript to UI
    ws.send(createMessage(MessageType.TRANSCRIPT, { text: transcript }));

    console.log('[Host] Routing spoken turn to OpenClaw...');
    const result = await executeTurn(ws, transcript);
    if (isTurnCancelled(ws, activeTurnId)) {
      console.log(`[Host] Turn ${activeTurnId} cancelled before response delivery`);
      sendState(ws, CliveState.IDLE);
      return;
    }

    let responseText = result.text;

    if (!result.success && FALLBACK_TO_LOCAL_LLM) {
      console.log('[Host] OpenClaw unavailable — using local personality fallback');
      responseText = await getResponse(transcript);
    }

    if (!responseText || responseText.trim().length === 0) {
      responseText = "That didn't work. Want me to try again?";
    }

    console.log(`[Host] Response: "${responseText}"`);
    hostRuntimeStatus.lastResponse = responseText;

    // Shape the response for TTS (metadata: brevity, energy, tone)
    const responseMetadata = shapeResponse(responseText, transcript);
    console.log(`[Host] Response shape: ${responseMetadata.brevity}/${responseMetadata.energy}/${responseMetadata.tone}`);

    // Smart response: detect long/listy content and split into spoken summary + display card
    const { spokenText, displayText, isLong } = splitResponse(responseText);

    // Get conversation context for CSM (if enabled)
    const contextSegments = getRecentTurns(5);

    if (isLong) {
      // Send brief spoken version + full display version
      ws.send(createMessage(MessageType.RESPONSE_TEXT, { text: spokenText }));
      ws.send(createMessage('response_display', { text: displayText, summary: spokenText }));
      sendState(ws, CliveState.SPEAKING);
      await speak(ws, spokenText, contextSegments);
      // Save Clive's spoken response to context buffer
      addTurn(SPEAKER_CLIVE, spokenText, null, { brevity: responseMetadata.brevity });
    } else {
      ws.send(createMessage(MessageType.RESPONSE_TEXT, { text: responseText }));
      sendState(ws, CliveState.SPEAKING);
      await speak(ws, responseText, contextSegments);
      // Save Clive's response to context buffer
      addTurn(SPEAKER_CLIVE, responseText, null, { brevity: responseMetadata.brevity });
    }

    // Return to idle
    sendState(ws, CliveState.IDLE);
  } catch (e) {
    console.error('[Host] Pipeline error:', e);
    ws.send(createMessage(MessageType.ERROR, { error: 'Something went wrong. Try again?' }));
    sendState(ws, CliveState.ERROR);

    // Return to idle after error
    setTimeout(() => sendState(ws, CliveState.IDLE), 3000);
  }
}

// ---- Confirmation Flow ----

function handleConfirmation(ws, payload) {
  console.log(`[Host] Confirmation: ${payload.confirmed}`);
  // Phase 2: forward to OpenClaw agent
  sendState(ws, CliveState.IDLE);
}

function handleCancel(ws) {
  console.log('[Host] Cancelled');
  cancelActiveTurn(ws);
  audioBuffers.set(ws, []); // Clear any buffered audio
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
  const next = {
    turnId: current.turnId + 1,
    cancelledTurnId: null,
  };
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

/**
 * Detect long/listy responses and split into a brief spoken summary + full display text.
 * Prevents Clive from reading 40 bullet points aloud and burning TTS credits.
 */
function splitResponse(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const charCount = text.length;

  // Count list indicators: bullets, dashes, numbered items, markdown bold sections
  const listLines = lines.filter(l => /^\s*[-*•]\s|^\s*\d+[.)]\s|^\*\*/.test(l.trim()));
  const hasLongList = listLines.length >= 4;
  const isVeryLong = charCount > 500;

  if (!hasLongList && !isVeryLong) {
    return { spokenText: text, displayText: text, isLong: false };
  }

  // Extract a spoken summary: first 1-2 sentences before any list starts
  let spokenText = '';

  const firstListIdx = lines.findIndex(l => /^\s*[-*•]\s|^\s*\d+[.)]\s|^\*\*/.test(l.trim()));

  if (firstListIdx > 0) {
    // There's intro text before the list — use it as the spoken part
    const introLines = lines.slice(0, firstListIdx);
    spokenText = introLines.join(' ').trim();
  }

  if (!spokenText || spokenText.length < 20) {
    // No good intro — generate a meta-description
    const itemCount = listLines.length || lines.length;
    const category = detectCategory(text);
    spokenText = `There are ${itemCount} items${category ? ` across ${category}` : ''}. I've put the full list on your screen below so you can review it.`;
  } else {
    spokenText += ` I've put the full details on your screen below.`;
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

// ---- Start ----

server.listen(PORT, () => {
  console.log(`[Host] Clive host server running on port ${PORT}`);
  console.log('[Host] Waiting for Pi client connection...');
});
