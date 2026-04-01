/**
 * Pi Client — Serves the UI and manages wake word detection.
 *
 * On the Pi, this runs as the main process:
 * 1. Serves the web UI on a local port (opened in Chromium kiosk)
 * 2. Runs Porcupine wake word detection
 * 3. Proxies audio between the browser and the host server
 *
 * For development on Mac, wake word is simulated via keyboard.
 */

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const PI_UI_PORT = 3000;
const PI_LOCAL_WS_PORT = process.env.PI_LOCAL_WS_PORT || 3001;

// ---- Serve UI ----

const app = express();
app.use(express.static(path.join(__dirname, '../public')));

app.listen(PI_UI_PORT, () => {
  console.log(`[Pi] UI serving on http://localhost:${PI_UI_PORT}`);
  console.log('[Pi] Open in Chromium kiosk mode for production');
});

// ---- Local Browser Relay ----

const localWss = new WebSocketServer({ port: PI_LOCAL_WS_PORT });
const localClients = new Set();

localWss.on('connection', (ws) => {
  localClients.add(ws);
  console.log('[Pi] Browser relay client connected');

  ws.on('close', () => {
    localClients.delete(ws);
    console.log('[Pi] Browser relay client disconnected');
  });

  ws.on('error', (error) => {
    console.error('[Pi] Browser relay error:', error.message);
  });
});

localWss.on('listening', () => {
  console.log(`[Pi] Local relay listening on ws://localhost:${PI_LOCAL_WS_PORT}`);
});

// ---- Wake Word Detection ----
// Porcupine integration — requires @picovoice/porcupine-node
// For dev on Mac, we skip this and use push-to-talk or keyboard trigger

let porcupineAvailable = false;

async function initWakeWord() {
  try {
    // Porcupine requires an access key from Picovoice Console (free tier)
    const accessKey = process.env.PICOVOICE_ACCESS_KEY;
    if (!accessKey) {
      console.log('[WakeWord] No PICOVOICE_ACCESS_KEY set. Wake word disabled.');
      console.log('[WakeWord] Get a free key at https://console.picovoice.ai/');
      console.log('[WakeWord] Using push-to-talk only.');
      return;
    }

    const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
    const { PvRecorder } = require('@picovoice/pvrecorder-node');

    // Use built-in "Hey Google" as placeholder, or custom "Hey Clive" .ppn file
    const keywordPath = process.env.PORCUPINE_KEYWORD_PATH;

    let porcupine;
    if (keywordPath) {
      porcupine = new Porcupine(accessKey, [keywordPath], [0.5]);
    } else {
      console.log('[WakeWord] No custom keyword file. Using "Porcupine" as test wake word.');
      porcupine = new Porcupine(accessKey, [BuiltinKeyword.PORCUPINE], [0.5]);
    }

    const recorder = new PvRecorder(porcupine.frameLength, -1);
    recorder.start();
    porcupineAvailable = true;

    console.log('[WakeWord] Listening for wake word...');

    // Detection loop
    while (true) {
      const pcm = await recorder.read();
      const keywordIndex = porcupine.process(pcm);

      if (keywordIndex >= 0) {
        console.log('[WakeWord] Detected!');
        onWakeWordDetected();
      }
    }
  } catch (e) {
    console.log(`[WakeWord] Init failed: ${e.message}`);
    console.log('[WakeWord] Continuing with push-to-talk only.');
  }
}

function onWakeWordDetected() {
  const payload = JSON.stringify({
    type: 'wake_word_detected',
    timestamp: Date.now(),
  });

  for (const client of localClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

// ---- Dev Mode: Keyboard Wake Word ----

if (process.stdin.isTTY) {
  const readline = require('readline');
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);

  console.log('[Dev] Press SPACE to simulate wake word');

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') process.exit();
    if (key.name === 'space') {
      console.log('[Dev] Wake word simulated');
      onWakeWordDetected();
    }
  });
}

// ---- Start ----

initWakeWord();
