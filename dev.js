/**
 * Combined dev launcher — starts both host server and Pi client.
 * Used for local development and preview.
 */

const { fork } = require('child_process');
const path = require('path');

// Start host server first
const host = fork(path.join(__dirname, 'host-server/src/index.js'), [], {
  env: { ...process.env, MOCK_STT: '1', MOCK_TTS: '1', MOCK_LLM: '1', HOST_PORT: '3100' },
  stdio: 'inherit',
});

// Start Pi client after a brief delay
setTimeout(() => {
  const pi = fork(path.join(__dirname, 'pi-client/src/server.js'), [], {
    env: { ...process.env, HOST_WS_URL: 'ws://localhost:3100' },
    stdio: 'inherit',
  });

  pi.on('exit', (code) => {
    console.log(`[Dev] Pi client exited (${code})`);
    host.kill();
    process.exit(code);
  });
}, 500);

host.on('exit', (code) => {
  console.log(`[Dev] Host server exited (${code})`);
  process.exit(code);
});
