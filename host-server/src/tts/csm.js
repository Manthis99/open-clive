/**
 * CSM (Conversational Speech Model) TTS Engine
 *
 * Manages a persistent Python process that holds CSM-1B in GPU VRAM.
 * Generates context-aware speech using recent conversation history.
 *
 * Requires:
 *   - NVIDIA GPU with CUDA (tested on 2080 TI, 11GB VRAM)
 *   - Python environment with: torch, torchaudio, transformers>=4.52.1
 *   - CSM-1B model (auto-downloaded from HuggingFace on first run)
 *
 * Protocol: JSON over stdin/stdout with the persistent csm_server.py process.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { MessageType, createMessage } = require('../../../shared/schemas/messages');

// ---- Configuration ----

const CSM_DEVICE = process.env.CSM_DEVICE || 'cuda';
const CSM_MAX_AUDIO_MS = parseInt(process.env.CSM_MAX_AUDIO_LENGTH_MS || '15000', 10);
const CSM_MAX_CONTEXT_TURNS = parseInt(process.env.CSM_MAX_CONTEXT_TURNS || '5', 10);
const CSM_SPEAKER_ID = parseInt(process.env.CSM_SPEAKER_ID || '0', 10);

// Voice seed: a reference audio clip that anchors CSM's voice identity.
// Without this, CSM picks a random voice on every cold start.
const CSM_VOICE_SEED = process.env.CSM_VOICE_SEED
  ? path.resolve(__dirname, '../../..', process.env.CSM_VOICE_SEED)
  : null;
const CSM_VOICE_SEED_TEXT = process.env.CSM_VOICE_SEED_TEXT || '';

// Detect platform-appropriate Python
const IS_WINDOWS = process.platform === 'win32';
const VENV_PYTHON = IS_WINDOWS
  ? path.join(__dirname, '../../../.venv/Scripts/python.exe')
  : path.join(__dirname, '../../../.venv/bin/python3');
const CSM_SERVER_SCRIPT = path.join(__dirname, 'csm_server.py');

// ---- State ----

let csmProcess = null;
let csmReady = false;
let requestQueue = [];
let currentResolve = null;
let currentReject = null;
let responseBuffer = '';

// ---- Process Management ----

/**
 * Start the persistent CSM server process.
 * The process loads the model into GPU VRAM and waits for generation requests.
 */
async function initCSM() {
  if (csmProcess) {
    console.log('[CSM] Server already running');
    return;
  }

  return new Promise((resolve, reject) => {
    const pythonPath = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
    console.log(`[CSM] Starting server: ${pythonPath} ${CSM_SERVER_SCRIPT}`);
    console.log(`[CSM] Device: ${CSM_DEVICE}, Max audio: ${CSM_MAX_AUDIO_MS}ms`);

    const env = {
      ...process.env,
      CSM_DEVICE,
      CSM_MAX_AUDIO_LENGTH_MS: String(CSM_MAX_AUDIO_MS),
      CSM_SPEAKER_ID: String(CSM_SPEAKER_ID),
      NO_TORCH_COMPILE: '1',
      PYTHONUNBUFFERED: '1',
    };

    csmProcess = spawn(pythonPath, [CSM_SERVER_SCRIPT], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '../../../external/csm'),
    });

    const CSM_STARTUP_TIMEOUT = 300000; // 5 min — first run downloads ~2GB of models
    let startupTimeout = setTimeout(() => {
      reject(new Error(`CSM server startup timed out (${CSM_STARTUP_TIMEOUT / 1000}s)`));
      shutdownCSM();
    }, CSM_STARTUP_TIMEOUT);

    // Handle stdout — JSON responses from the server
    csmProcess.stdout.on('data', (data) => {
      responseBuffer += data.toString();

      // Process complete JSON lines
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          if (msg.type === 'ready') {
            console.log(`[CSM] Server ready — model loaded on ${msg.device}, VRAM: ${msg.vram_mb || '?'}MB`);
            csmReady = true;
            clearTimeout(startupTimeout);
            resolve();
          } else if (msg.type === 'audio') {
            // Base64-encoded audio response
            if (currentResolve) {
              currentResolve(Buffer.from(msg.data, 'base64'));
              currentResolve = null;
              currentReject = null;
            }
          } else if (msg.type === 'error') {
            console.error('[CSM] Server error:', msg.message);
            if (currentReject) {
              currentReject(new Error(msg.message));
              currentResolve = null;
              currentReject = null;
            }
          } else if (msg.type === 'stats') {
            console.log(`[CSM] Generation: ${msg.duration_ms}ms, ${msg.audio_length_ms}ms audio, VRAM: ${msg.vram_mb}MB`);
          }
        } catch (e) {
          // Not JSON — probably a log line, forward to console
          if (line.trim()) {
            console.log(`[CSM/py] ${line.trim()}`);
          }
        }
      }
    });

    // Forward stderr for debugging
    csmProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        // Filter out torch download progress bars
        if (!text.includes('Downloading') && !text.includes('███')) {
          console.log(`[CSM/py] ${text}`);
        }
      }
    });

    csmProcess.on('exit', (code, signal) => {
      console.log(`[CSM] Server exited (code=${code}, signal=${signal})`);
      csmProcess = null;
      csmReady = false;
      if (currentReject) {
        currentReject(new Error('CSM server process exited'));
        currentResolve = null;
        currentReject = null;
      }
    });

    csmProcess.on('error', (err) => {
      console.error('[CSM] Failed to start server:', err.message);
      clearTimeout(startupTimeout);
      reject(err);
    });
  });
}

/**
 * Shut down the CSM server process gracefully.
 */
async function shutdownCSM() {
  if (!csmProcess) return;

  console.log('[CSM] Shutting down server...');
  try {
    // Send shutdown command
    csmProcess.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    // Give it 5 seconds to clean up
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (csmProcess) csmProcess.kill('SIGKILL');
        resolve();
      }, 5000);
      csmProcess.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch {
    if (csmProcess) csmProcess.kill('SIGKILL');
  }
  csmProcess = null;
  csmReady = false;
}

// ---- Speech Generation ----

/**
 * Generate speech audio from text using CSM.
 * Sends audio data to the WebSocket client.
 *
 * @param {WebSocket} ws - Client WebSocket
 * @param {string} text - Text to speak
 * @param {Array} contextSegments - Optional conversation context for CSM
 */
async function speakCSM(ws, text, contextSegments = []) {
  if (!csmReady) {
    throw new Error('CSM server not ready');
  }

  // Build context: voice seed first (anchors identity), then conversation history
  const contextEntries = [];

  // Prepend voice seed if configured — this gives CSM a consistent voice reference
  if (CSM_VOICE_SEED && fs.existsSync(CSM_VOICE_SEED)) {
    contextEntries.push({
      text: CSM_VOICE_SEED_TEXT,
      speaker: CSM_SPEAKER_ID,
      audio_path: CSM_VOICE_SEED,
    });
  }

  // Add conversation context
  for (const seg of contextSegments.slice(-CSM_MAX_CONTEXT_TURNS)) {
    contextEntries.push({
      text: seg.text,
      speaker: seg.speaker,
      audio_path: seg.audioPath || null,
    });
  }

  const request = {
    type: 'generate',
    text,
    speaker: CSM_SPEAKER_ID,
    max_audio_length_ms: CSM_MAX_AUDIO_MS,
    context: contextEntries,
  };

  try {
    const audioData = await sendRequest(request);

    if (ws.readyState === 1) {
      ws.send(audioData);
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }

    console.log(`[CSM] Spoke: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}" (${(audioData.length / 1024).toFixed(1)}kb)`);
    return audioData;
  } catch (e) {
    console.error('[CSM] Generation failed:', e.message);
    if (ws.readyState === 1) {
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }
    throw e;
  }
}

/**
 * Send a request to the CSM server and wait for response.
 */
function sendRequest(request) {
  return new Promise((resolve, reject) => {
    if (!csmProcess || !csmReady) {
      reject(new Error('CSM server not available'));
      return;
    }

    // Simple sequential request handling
    currentResolve = resolve;
    currentReject = reject;

    const timeout = setTimeout(() => {
      if (currentReject === reject) {
        currentResolve = null;
        currentReject = null;
        reject(new Error('CSM generation timed out (60s)'));
      }
    }, 60000);

    const origResolve = resolve;
    currentResolve = (data) => {
      clearTimeout(timeout);
      origResolve(data);
    };

    csmProcess.stdin.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Check if CSM server is running and healthy.
 */
function isCSMReady() {
  return csmReady && csmProcess !== null;
}

module.exports = {
  initCSM,
  shutdownCSM,
  speakCSM,
  isCSMReady,
};
