/**
 * Pi Client — local UI server for Clive's touchscreen.
 *
 * Production architecture:
 * 1. Chromium kiosk loads this UI locally on the Pi.
 * 2. The Python listener owns the microphone and wake word detection.
 * 3. The browser is display-first and only uses browser mic capture as a fallback.
 */

const express = require('express');
const path = require('path');

const PI_UI_PORT = parseInt(process.env.PI_UI_PORT || '3000', 10);
const DEFAULT_HOSTNAME = process.env.CLIVE_HOSTNAME || 'localhost';
const HOST_HTTP_URL = process.env.CLIVE_HOST_HTTP_URL || `http://${DEFAULT_HOSTNAME}:3100`;
const HOST_WS_URL = process.env.CLIVE_HOST_WS_URL || `ws://${DEFAULT_HOSTNAME}:3100`;

const app = express();

app.get('/clive-config.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(
    `window.CLIVE_CONFIG = ${JSON.stringify({
      hostHttpUrl: HOST_HTTP_URL,
      hostWsUrl: HOST_WS_URL,
      uiPort: PI_UI_PORT,
    })};`
  );
});

app.use(express.static(path.join(__dirname, '../public')));

app.listen(PI_UI_PORT, () => {
  console.log(`[Pi] UI serving on http://localhost:${PI_UI_PORT}`);
  console.log(`[Pi] Host HTTP: ${HOST_HTTP_URL}`);
  console.log(`[Pi] Host WS: ${HOST_WS_URL}`);
});
