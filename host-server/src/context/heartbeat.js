/**
 * Heartbeat background scheduler
 * 
 * Runs periodic background checks to ensure Clive stays "alive"
 * even when not actively being spoken to.
 */

const { executeTurn } = require('../agent/openclaw');
const { MessageType, CliveState, createMessage } = require('../../../shared/schemas/messages');

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
let heartbeatTimer = null;
let lastHeartbeatActivity = Date.now();

// We need references to the host server's broadcast methods
let _broadcastJson = null;

function startHeartbeat(broadcastJson) {
  _broadcastJson = broadcastJson;

  if (heartbeatTimer) clearInterval(heartbeatTimer);

  console.log(`[Heartbeat] Started. Internal tick every ${HEARTBEAT_INTERVAL_MS}ms`);
  
  heartbeatTimer = setInterval(() => {
    tick();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}

function resetHeartbeatActivity() {
  lastHeartbeatActivity = Date.now();
}

/**
 * The internal tick function. What should Clive do independently?
 */
async function tick() {
  const idleTimeMs = Date.now() - lastHeartbeatActivity;
  
  // Example: If Clive has been idle for exactly 5 minutes, ping OpenClaw for an ambient thought.
  // We can send a hidden system prompt.
  if (idleTimeMs > 5 * 60 * 1000 && idleTimeMs < 6 * 60 * 1000) {
    console.log('[Heartbeat] Clive has been idle. Triggering ambient thought process.');
    // In a future feature, we might route this quietly to a "ponder" endpoint on OpenClaw
    // instead of speaking out loud immediately.
  }
}

module.exports = {
  startHeartbeat,
  stopHeartbeat,
  resetHeartbeatActivity
};
