/**
 * Text-to-Speech module.
 *
 * Priority:
 * 1. CSM local GPU (if CSM_ENABLED=1) — context-aware speech generation
 * 2. Resemble AI (if RESEMBLE_API_KEY is set)
 * 3. ElevenLabs API (if ELEVENLABS_API_KEY is set)
 * 4. Piper local TTS (if model exists)
 * 5. Mock (no audio)
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleAuth } = require('google-auth-library');
const { MessageType, createMessage } = require('../../../shared/schemas/messages');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '29vD33N1CtxCmqQRPOHJ';
const MODEL_ID = 'eleven_turbo_v2_5';
const RESEMBLE_API_KEY = process.env.RESEMBLE_API_KEY;
const RESEMBLE_VOICE_UUID = process.env.RESEMBLE_VOICE_UUID || 'bec88a80';
const RESEMBLE_MODEL = process.env.RESEMBLE_MODEL || 'chatterbox-turbo';
const RESEMBLE_SAMPLE_RATE = parseInt(process.env.RESEMBLE_SAMPLE_RATE || '22050', 10);
const GOOGLE_TTS_ENABLED =
  process.env.GOOGLE_TTS_ENABLED === '1' || process.env.GOOGLE_TTS_ENABLED === 'true';
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GOOGLE_TTS_LANGUAGE_CODE = process.env.GOOGLE_TTS_LANGUAGE_CODE || 'en-AU';
const GOOGLE_TTS_VOICE_NAME = process.env.GOOGLE_TTS_VOICE_NAME || 'en-AU-Chirp3-HD-Fenrir';
const GOOGLE_TTS_SAMPLE_RATE = parseInt(process.env.GOOGLE_TTS_SAMPLE_RATE || '24000', 10);
const CACHE_DIR = path.join(__dirname, '../../../pi-client/public/audio');
const TTS_SPEED = parseFloat(process.env.CLIVE_TTS_SPEED || '1.35');
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

const PIPER_SCRIPT = path.join(__dirname, 'synthesize.py');
const PIPER_MODEL = path.join(__dirname, '../../../models/en_US-lessac-medium.onnx');
const IS_WINDOWS = process.platform === 'win32';
const VENV_PYTHON = IS_WINDOWS
  ? path.join(__dirname, '../../../.venv/Scripts/python.exe')
  : path.join(__dirname, '../../../.venv/bin/python3');

const USE_MOCK = process.env.MOCK_TTS === '1' || process.env.MOCK_TTS === 'true';
const CSM_ENABLED = process.env.CSM_ENABLED === '1';
const HAS_GOOGLE_TTS = GOOGLE_TTS_ENABLED && !!GOOGLE_CLOUD_PROJECT;
const HAS_RESEMBLE = !!RESEMBLE_API_KEY;
const HAS_ELEVENLABS = !!API_KEY;
const HAS_PIPER = fs.existsSync(PIPER_MODEL) && fs.existsSync(VENV_PYTHON);

// CSM module (lazy-loaded when engine is 'csm')
let csmModule = null;

let ttsEngine = 'mock';
if (USE_MOCK) {
  ttsEngine = 'mock';
} else if (CSM_ENABLED) {
  ttsEngine = 'csm';
} else if (HAS_GOOGLE_TTS) {
  ttsEngine = 'google';
} else if (HAS_RESEMBLE) {
  ttsEngine = 'resemble';
} else if (HAS_ELEVENLABS) {
  ttsEngine = 'elevenlabs';
} else if (HAS_PIPER) {
  ttsEngine = 'piper';
}

const ENGINE_LABELS = {
  mock: '',
  csm: ' (local GPU)',
  google: ' (cloud)',
  resemble: ' (cloud)',
  elevenlabs: ' (cloud)',
  piper: ' (local CPU)',
};
console.log(`[TTS] Engine: ${ttsEngine}${ENGINE_LABELS[ttsEngine] || ''}`);

/**
 * Speak text and send audio to the client WebSocket.
 */
async function speak(ws, text, contextSegments = []) {
  switch (ttsEngine) {
    case 'csm':
      return speakWithCSM(ws, text, contextSegments);
    case 'google':
      return speakGoogle(ws, text);
    case 'resemble':
      return speakResemble(ws, text);
    case 'elevenlabs':
      return speakElevenLabs(ws, text);
    case 'piper':
      return speakPiper(ws, text);
    default:
      return mockSpeak(ws, text);
  }
}

// ---- CSM (local GPU) ----

async function speakWithCSM(ws, text, contextSegments = []) {
  try {
    if (!csmModule) {
      csmModule = require('./csm');
    }
    if (!csmModule.isCSMReady()) {
      console.warn('[TTS] CSM not ready, falling back to next available engine');
      // Fallback chain: Google > Resemble > ElevenLabs > Piper > Mock
      if (HAS_GOOGLE_TTS) return speakGoogle(ws, text);
      if (HAS_RESEMBLE) return speakResemble(ws, text);
      if (HAS_ELEVENLABS) return speakElevenLabs(ws, text);
      if (HAS_PIPER) return speakPiper(ws, text);
      return mockSpeak(ws, text);
    }
    return await csmModule.speakCSM(ws, text, contextSegments);
  } catch (e) {
    console.error('[TTS/CSM] Error, falling back:', e.message);
    if (HAS_GOOGLE_TTS) return speakGoogle(ws, text);
    if (HAS_ELEVENLABS) return speakElevenLabs(ws, text);
    if (HAS_PIPER) return speakPiper(ws, text);
    return mockSpeak(ws, text);
  }
}

/**
 * Initialize the TTS engine (starts persistent GPU processes if needed).
 */
async function initTTS() {
  if (ttsEngine === 'csm') {
    if (!csmModule) csmModule = require('./csm');
    await csmModule.initCSM();
  }
}

/**
 * Shut down TTS engine (cleans up GPU processes).
 */
async function shutdownTTS() {
  if (csmModule) {
    await csmModule.shutdownCSM();
  }
}

// ---- Google Gemini TTS (cloud) ----

const googleAuth = HAS_GOOGLE_TTS
  ? new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
  : null;

async function speakGoogle(ws, text) {
  try {
    const authClient = await googleAuth.getClient();
    const accessTokenResponse = await authClient.getAccessToken();
    const accessToken =
      typeof accessTokenResponse === 'string'
        ? accessTokenResponse
        : accessTokenResponse?.token;

    if (!accessToken) {
      throw new Error('No Google Cloud access token available');
    }

    const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-goog-user-project': GOOGLE_CLOUD_PROJECT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: GOOGLE_TTS_LANGUAGE_CODE,
          name: GOOGLE_TTS_VOICE_NAME,
        },
        audioConfig: {
          audioEncoding: 'LINEAR16',
          sampleRateHertz: GOOGLE_TTS_SAMPLE_RATE,
        },
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Google TTS API error ${response.status}: ${rawText || 'no response body'}`);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Failed to parse Google TTS response: ${error.message}`);
    }

    if (!payload?.audioContent) {
      throw new Error('Google TTS returned no audio');
    }

    const pcmAudio = Buffer.from(payload.audioContent, 'base64');
    const wavAudio = wrapPcmAsWav(pcmAudio, GOOGLE_TTS_SAMPLE_RATE);

    if (ws.readyState === 1) {
      ws.send(wavAudio);
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }

    console.log(
      `[TTS/Google] Sent ${(wavAudio.length / 1024).toFixed(1)}kb audio using ${GOOGLE_TTS_LANGUAGE_CODE}/${GOOGLE_TTS_VOICE_NAME}`
    );
  } catch (e) {
    console.error('[TTS/Google] Error:', e.message);
    if (HAS_RESEMBLE) return speakResemble(ws, text);
    if (HAS_ELEVENLABS) return speakElevenLabs(ws, text);
    if (HAS_PIPER) return speakPiper(ws, text);
    if (ws.readyState === 1) {
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }
  }
}

function wrapPcmAsWav(pcmBuffer, sampleRate, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// ---- Resemble (cloud) ----

async function speakResemble(ws, text) {
  try {
    const response = await fetch('https://f.cluster.resemble.ai/synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEMBLE_API_KEY}`,
      },
      body: JSON.stringify({
        voice_uuid: RESEMBLE_VOICE_UUID,
        data: text,
        model: RESEMBLE_MODEL,
        output_format: 'mp3',
        sample_rate: RESEMBLE_SAMPLE_RATE,
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Resemble API error ${response.status}: ${rawText || 'no response body'}`);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`Failed to parse Resemble response: ${error.message}`);
    }

    if (!payload?.success || !payload?.audio_content) {
      throw new Error(payload?.message || 'Resemble returned no audio');
    }

    const fullAudio = Buffer.from(payload.audio_content, 'base64');
    const processedAudio = await maybeAdjustTempo(fullAudio);

    if (ws.readyState === 1) {
      ws.send(processedAudio);
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }

    console.log(`[TTS/Resemble] Sent ${(processedAudio.length / 1024).toFixed(1)}kb audio at ${TTS_SPEED}x tempo`);
  } catch (e) {
    console.error('[TTS/Resemble] Error:', e.message);
    if (ws.readyState === 1) {
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }
  }
}

/**
 * Speak a cached/common phrase.
 */
async function speakCached(ws, text) {
  const wavCache = path.join(CACHE_DIR, sanitizeFilename(text) + '.wav');
  const mp3Cache = path.join(CACHE_DIR, sanitizeFilename(text) + '.mp3');

  for (const cacheFile of [wavCache, mp3Cache]) {
    if (fs.existsSync(cacheFile)) {
      const audioData = fs.readFileSync(cacheFile);
      if (ws.readyState === 1) {
        ws.send(audioData);
        ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
      }
      return;
    }
  }

  await speak(ws, text);
}

// ---- Piper (local) ----

async function speakPiper(ws, text) {
  const tmpFile = path.join(os.tmpdir(), `clive_tts_${Date.now()}.wav`);

  try {
    await new Promise((resolve, reject) => {
      execFile(VENV_PYTHON, [PIPER_SCRIPT, text, tmpFile], {
        timeout: 15000,
      }, (error, stdout, stderr) => {
        if (error) {
          console.error('[TTS/Piper] Error:', stderr || error.message);
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });

    const audioData = fs.readFileSync(tmpFile);
    if (ws.readyState === 1) {
      ws.send(audioData);
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }
    console.log(`[TTS/Piper] Spoke: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  } catch (e) {
    console.error('[TTS/Piper] Failed:', e.message);
    if (ws.readyState === 1) {
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---- ElevenLabs (cloud) ----

async function speakElevenLabs(ws, text) {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: {
            stability: 0.6,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true,
          },
          // Keep generation natural here; if needed, tempo is adjusted locally
          // with ffmpeg so pitch stays steady.
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
    }

    // Buffer the full audio response, then send as one complete blob
    // Streaming individual chunks causes choppy playback because
    // partial MP3 frames can't be decoded independently
    const chunks = [];
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // Combine into single buffer and send
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const fullAudio = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      fullAudio.set(chunk, offset);
      offset += chunk.length;
    }

    const processedAudio = await maybeAdjustTempo(Buffer.from(fullAudio));

    if (ws.readyState === 1) {
      ws.send(processedAudio);
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }

    console.log(`[TTS/ElevenLabs] Sent ${(processedAudio.length / 1024).toFixed(1)}kb audio at ${TTS_SPEED}x tempo`);
  } catch (e) {
    console.error('[TTS/ElevenLabs] Error:', e.message);
    if (ws.readyState === 1) {
      ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
    }
  }
}

async function maybeAdjustTempo(audioBuffer) {
  if (!Number.isFinite(TTS_SPEED) || TTS_SPEED <= 1.0) {
    return audioBuffer;
  }

  const inputFile = path.join(os.tmpdir(), `clive_tts_in_${Date.now()}.mp3`);
  const outputFile = path.join(os.tmpdir(), `clive_tts_out_${Date.now()}.mp3`);

  try {
    fs.writeFileSync(inputFile, audioBuffer);

    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG_BIN,
        [
          '-y',
          '-i', inputFile,
          '-filter:a', `atempo=${TTS_SPEED}`,
          '-c:a', 'libmp3lame',
          '-b:a', '160k',
          outputFile,
        ],
        { timeout: 15000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    return fs.readFileSync(outputFile);
  } catch (error) {
    console.warn(`[TTS/ElevenLabs] Tempo adjustment skipped: ${error.message}`);
    return audioBuffer;
  } finally {
    try { fs.unlinkSync(inputFile); } catch {}
    try { fs.unlinkSync(outputFile); } catch {}
  }
}

// ---- Mock ----

function mockSpeak(ws, text) {
  console.log(`[TTS] Mock: "${text}"`);
  if (ws.readyState === 1) {
    ws.send(createMessage(MessageType.RESPONSE_AUDIO_END));
  }
  return Promise.resolve();
}

function sanitizeFilename(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
}

module.exports = { speak, speakCached, initTTS, shutdownTTS };
