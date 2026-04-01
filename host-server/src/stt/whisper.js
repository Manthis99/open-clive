/**
 * Speech-to-Text using faster-whisper.
 *
 * Two modes:
 *   1. Per-call subprocess (default) — spawns Python for each transcription
 *   2. Persistent server (WHISPER_PERSISTENT=1) — keeps model in GPU VRAM
 *
 * Receives raw PCM audio (16-bit, 16kHz, mono), writes to temp file,
 * transcribes via faster-whisper, returns transcript.
 *
 * For dev/testing: falls back to a mock transcription.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WHISPER_SCRIPT = path.join(__dirname, 'transcribe.py');
const WHISPER_SERVER_SCRIPT = path.join(__dirname, 'whisper_server.py');
const IS_WINDOWS = process.platform === 'win32';
const VENV_PYTHON = IS_WINDOWS
  ? path.join(__dirname, '../../../.venv/Scripts/python.exe')
  : path.join(__dirname, '../../../.venv/bin/python3');
const USE_MOCK = process.env.MOCK_STT === '1' || process.env.MOCK_STT === 'true';
const USE_PERSISTENT = process.env.WHISPER_PERSISTENT === '1';

// ---- Persistent Server State ----

let whisperProcess = null;
let whisperReady = false;
let currentResolve = null;
let currentReject = null;
let responseBuffer = '';

// ---- Public API ----

async function transcribe(pcmBuffer) {
  if (USE_MOCK) {
    return mockTranscribe();
  }

  // Write PCM to a temp WAV file
  const tmpFile = path.join(os.tmpdir(), `clive_audio_${Date.now()}.wav`);

  try {
    const wavBuffer = createWavBuffer(pcmBuffer, 16000, 1, 16);
    fs.writeFileSync(tmpFile, wavBuffer);

    if (USE_PERSISTENT && whisperReady) {
      return await transcribePersistent(tmpFile);
    }

    // Per-call mode
    const transcript = await runWhisperSubprocess(tmpFile);
    return transcript.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Start the persistent Whisper server (keeps model in GPU VRAM).
 * Call this at startup when WHISPER_PERSISTENT=1.
 */
async function initPersistentSTT() {
  if (!USE_PERSISTENT) return;
  if (whisperProcess) {
    console.log('[STT] Persistent server already running');
    return;
  }

  return new Promise((resolve, reject) => {
    const pythonPath = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : (IS_WINDOWS ? 'python' : 'python3');
    console.log(`[STT] Starting persistent Whisper server: ${pythonPath} ${WHISPER_SERVER_SCRIPT}`);

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    };

    whisperProcess = spawn(pythonPath, [WHISPER_SERVER_SCRIPT], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let startupTimeout = setTimeout(() => {
      reject(new Error('Whisper server startup timed out (60s)'));
      shutdownSTT();
    }, 60000);

    whisperProcess.stdout.on('data', (data) => {
      responseBuffer += data.toString();
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (msg.type === 'ready') {
            console.log(`[STT] Persistent server ready — model=${msg.model}, device=${msg.device}, VRAM=${msg.vram_mb || '?'}MB`);
            whisperReady = true;
            clearTimeout(startupTimeout);
            resolve();
          } else if (msg.type === 'transcript') {
            if (currentResolve) {
              currentResolve(msg.text || '');
              currentResolve = null;
              currentReject = null;
            }
          } else if (msg.type === 'error') {
            console.error('[STT] Server error:', msg.message);
            if (currentReject) {
              currentReject(new Error(msg.message));
              currentResolve = null;
              currentReject = null;
            }
          }
        } catch {
          if (line.trim()) console.log(`[STT/py] ${line.trim()}`);
        }
      }
    });

    whisperProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[STT/py] ${text}`);
    });

    whisperProcess.on('exit', (code, signal) => {
      console.log(`[STT] Persistent server exited (code=${code}, signal=${signal})`);
      whisperProcess = null;
      whisperReady = false;
      if (currentReject) {
        currentReject(new Error('Whisper server process exited'));
        currentResolve = null;
        currentReject = null;
      }
    });

    whisperProcess.on('error', (err) => {
      console.error('[STT] Failed to start persistent server:', err.message);
      clearTimeout(startupTimeout);
      reject(err);
    });
  });
}

/**
 * Shut down the persistent Whisper server.
 */
async function shutdownSTT() {
  if (!whisperProcess) return;
  console.log('[STT] Shutting down persistent server...');
  try {
    whisperProcess.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (whisperProcess) whisperProcess.kill('SIGKILL');
        resolve();
      }, 5000);
      whisperProcess.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch {
    if (whisperProcess) whisperProcess.kill('SIGKILL');
  }
  whisperProcess = null;
  whisperReady = false;
}

// ---- Persistent Transcription ----

function transcribePersistent(audioPath) {
  return new Promise((resolve, reject) => {
    if (!whisperProcess || !whisperReady) {
      reject(new Error('Whisper server not available'));
      return;
    }

    currentResolve = resolve;
    currentReject = reject;

    const timeout = setTimeout(() => {
      if (currentReject === reject) {
        currentResolve = null;
        currentReject = null;
        reject(new Error('Whisper transcription timed out (30s)'));
      }
    }, 30000);

    const origResolve = resolve;
    currentResolve = (data) => {
      clearTimeout(timeout);
      origResolve(data);
    };

    whisperProcess.stdin.write(JSON.stringify({
      type: 'transcribe',
      audio_path: audioPath,
    }) + '\n');
  });
}

// ---- Per-Call Subprocess ----

function runWhisperSubprocess(audioPath) {
  const pythonPath = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : (IS_WINDOWS ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    execFile(pythonPath, [WHISPER_SCRIPT, audioPath], {
      timeout: 30000,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[STT] Whisper error:', stderr || error.message);
        reject(new Error(`Whisper failed: ${error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// ---- WAV Helper ----

function createWavBuffer(pcmBuffer, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

// ---- Mock ----

const mockResponses = [
  "What time is it?",
  "Open my browser.",
  "What's on my calendar today?",
  "Close all my tabs.",
  "Remind me to check email in an hour.",
];

let mockIndex = 0;

function mockTranscribe() {
  const text = mockResponses[mockIndex % mockResponses.length];
  mockIndex++;
  console.log(`[STT] Mock transcript: "${text}"`);
  return Promise.resolve(text);
}

module.exports = { transcribe, initPersistentSTT, shutdownSTT };
