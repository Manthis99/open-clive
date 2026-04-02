/**
 * OpenClaw Agent Integration — Gateway WebSocket Client
 *
 * Connects to the OpenClaw Gateway over a persistent bidirectional WebSocket,
 * the same way Discord, iMessage, and other channel connectors do.
 *
 * Protocol: OpenClaw Gateway WS v3
 *   - Connect frame (handshake with auth + role)
 *   - Request/Response frames (RPC for chat turns)
 *   - Event frames (server-pushed: heartbeat, proactive messages)
 */

const WebSocket = require('ws');
const { MessageType, CliveState, createMessage } = require('../../../shared/schemas/messages');

// ---- Configuration ----

const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'main';
const OPENCLAW_TIMEOUT = parseInt(process.env.OPENCLAW_TIMEOUT || '120', 10);
const OPENCLAW_STATUS_LABEL = process.env.OPENCLAW_STATUS_LABEL || 'Clive is thinking';
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_SESSION_USER = process.env.OPENCLAW_SESSION_USER || 'clive-voice';
const OPENCLAW_RUNTIME_STYLE_PROMPT =
  process.env.OPENCLAW_RUNTIME_STYLE_PROMPT ||
  'Reply in one sentence by default. Use two short sentences only when the extra context is genuinely necessary. Do not give full paragraphs unless the user explicitly asks for depth. Be crisp, conversational, and never long-winded.';

const USE_MOCK = process.env.MOCK_AGENT === '1' || process.env.MOCK_AGENT === 'true';

// Convert http(s) URL to ws(s) URL for the WebSocket connection
const GATEWAY_WS_URL = OPENCLAW_GATEWAY_URL
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:');

// ---- Runtime State ----

const agentRuntimeStatus = {
  mode: USE_MOCK ? 'mock' : 'gateway-ws',
  gatewayUrl: OPENCLAW_GATEWAY_URL,
  agentId: OPENCLAW_AGENT,
  healthy: USE_MOCK,
  connected: false,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  reconnectAttempts: 0,
};

// Pending RPC requests waiting for responses, keyed by request ID
const pendingRequests = new Map();

// Listeners for proactive events from OpenClaw (heartbeat, nudges, etc.)
const eventListeners = new Set();

let gatewaySocket = null;
let requestIdCounter = 0;
let reconnectTimer = null;
let heartbeatInterval = null;

// ---- Logging ----

if (USE_MOCK) {
  console.log('[Agent] Mock mode — OpenClaw disabled');
} else {
  console.log(`[Agent] OpenClaw agent: ${OPENCLAW_AGENT} via Gateway WebSocket at ${GATEWAY_WS_URL}`);
}

// ---- Gateway WebSocket Connection ----

function connect() {
  if (USE_MOCK || gatewaySocket) return;

  if (!OPENCLAW_GATEWAY_TOKEN) {
    console.error('[Agent] OPENCLAW_GATEWAY_TOKEN is not set — cannot connect to Gateway');
    agentRuntimeStatus.lastError = 'OPENCLAW_GATEWAY_TOKEN is not set';
    return;
  }

  console.log(`[Agent] Connecting to Gateway at ${GATEWAY_WS_URL}...`);

  try {
    gatewaySocket = new WebSocket(GATEWAY_WS_URL);
  } catch (err) {
    console.error('[Agent] Failed to create WebSocket:', err.message);
    scheduleReconnect();
    return;
  }

  gatewaySocket.on('open', () => {
    console.log('[Agent] WebSocket open — sending connect handshake');

    // OpenClaw Gateway protocol v3: first frame must be a connect request
    const connectFrame = {
      type: 'connect',
      protocol: 3,
      client: {
        name: 'clive-desk-companion',
        version: '0.2.0',
      },
      role: 'operator',
      scopes: ['chat', 'agent', 'status'],
      token: OPENCLAW_GATEWAY_TOKEN,
    };

    gatewaySocket.send(JSON.stringify(connectFrame));
  });

  gatewaySocket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      console.warn('[Agent] Received non-JSON frame from Gateway');
      return;
    }

    handleGatewayFrame(frame);
  });

  gatewaySocket.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'no reason';
    console.log(`[Agent] Gateway WebSocket closed: ${code} — ${reasonStr}`);
    cleanup();
    scheduleReconnect();
  });

  gatewaySocket.on('error', (err) => {
    console.error('[Agent] Gateway WebSocket error:', err.message);
    agentRuntimeStatus.lastError = err.message;
    agentRuntimeStatus.lastErrorAt = Date.now();
    // 'close' event will fire after 'error', which triggers reconnect
  });
}

function cleanup() {
  gatewaySocket = null;
  agentRuntimeStatus.connected = false;
  agentRuntimeStatus.healthy = false;

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Reject all pending requests
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error('Gateway connection lost'));
    pendingRequests.delete(id);
  }
}

function scheduleReconnect() {
  if (USE_MOCK || reconnectTimer) return;

  agentRuntimeStatus.reconnectAttempts++;
  // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
  const delay = Math.min(1000 * Math.pow(2, agentRuntimeStatus.reconnectAttempts - 1), 30000);
  console.log(`[Agent] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${agentRuntimeStatus.reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ---- Frame Handling ----

function handleGatewayFrame(frame) {
  switch (frame.type) {
    case 'connected':
      handleConnected(frame);
      break;

    case 'response':
      handleResponse(frame);
      break;

    case 'event':
      handleEvent(frame);
      break;

    case 'error':
      handleGatewayError(frame);
      break;

    case 'pong':
      // Heartbeat response — connection is alive
      break;

    default:
      console.log(`[Agent] Unknown Gateway frame type: ${frame.type}`);
  }
}

function handleConnected(frame) {
  console.log(`[Agent] Connected to Gateway — session: ${frame.sessionId || 'unknown'}`);
  agentRuntimeStatus.connected = true;
  agentRuntimeStatus.healthy = true;
  agentRuntimeStatus.reconnectAttempts = 0;
  agentRuntimeStatus.lastError = null;

  // Start heartbeat pings to keep connection alive
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (gatewaySocket && gatewaySocket.readyState === WebSocket.OPEN) {
      gatewaySocket.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);
}

function handleResponse(frame) {
  const pending = pendingRequests.get(frame.id);
  if (!pending) {
    console.warn(`[Agent] Received response for unknown request: ${frame.id}`);
    return;
  }

  pendingRequests.delete(pending.id);
  clearTimeout(pending.timer);

  if (frame.error) {
    pending.reject(new Error(frame.error.message || 'Gateway returned error'));
  } else {
    pending.resolve(frame.result);
  }
}

function handleEvent(frame) {
  const eventType = frame.event || frame.name;
  console.log(`[Agent] Gateway event: ${eventType}`);

  // Notify all registered event listeners
  for (const listener of eventListeners) {
    try {
      listener(frame);
    } catch (err) {
      console.error('[Agent] Event listener error:', err.message);
    }
  }
}

function handleGatewayError(frame) {
  const msg = frame.message || frame.error || 'Unknown Gateway error';
  console.error(`[Agent] Gateway error: ${msg}`);
  agentRuntimeStatus.lastError = msg;
  agentRuntimeStatus.lastErrorAt = Date.now();

  // If it's an auth error, don't keep retrying
  if (frame.code === 'auth_failed' || frame.code === 'unauthorized') {
    console.error('[Agent] Auth failed — check OPENCLAW_GATEWAY_TOKEN. Stopping reconnect.');
    agentRuntimeStatus.reconnectAttempts = Infinity;
  }
}

// ---- RPC: Send Request, Await Response ----

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) {
      reject(new Error('Gateway WebSocket not connected'));
      return;
    }

    const id = `clive-${++requestIdCounter}`;
    const frame = {
      type: 'request',
      id,
      method,
      params,
    };

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Gateway request timed out after ${OPENCLAW_TIMEOUT}s`));
    }, OPENCLAW_TIMEOUT * 1000);

    pendingRequests.set(id, { id, resolve, reject, timer });
    gatewaySocket.send(JSON.stringify(frame));
  });
}

// ---- Public API ----

/**
 * Execute a single spoken turn via OpenClaw.
 * Returns { success, text, meta }
 */
async function executeTurn(ws, userRequest) {
  if (USE_MOCK) {
    return mockExecute(ws, userRequest);
  }

  // Ensure we're connected (or try to connect)
  if (!gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) {
    connect();
    // Give it a moment to connect
    await new Promise((r) => setTimeout(r, 2000));
    if (!gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) {
      return {
        success: false,
        text: 'OpenClaw Gateway is not connected.',
        meta: null,
      };
    }
  }

  // Show active reasoning state while OpenClaw handles the turn
  sendState(ws, CliveState.WORKING);
  sendTaskStatus(ws, OPENCLAW_STATUS_LABEL, userRequest);

  try {
    console.log(`[Agent] Sending to OpenClaw: "${userRequest.substring(0, 80)}${userRequest.length > 80 ? '...' : ''}"`);

    const result = await sendRequest('chat.completions', {
      agent: OPENCLAW_AGENT,
      user: OPENCLAW_SESSION_USER,
      messages: [
        { role: 'system', content: OPENCLAW_RUNTIME_STYLE_PROMPT },
        { role: 'user', content: userRequest },
      ],
    });

    const responseText = extractResponseText(result);

    if (responseText) {
      agentRuntimeStatus.healthy = true;
      agentRuntimeStatus.lastSuccessAt = Date.now();
      agentRuntimeStatus.lastError = null;
      console.log(`[Agent] Turn completed`);

      return {
        success: true,
        text: responseText,
        meta: result?.meta || result?.usage || null,
      };
    } else {
      return {
        success: false,
        text: 'OpenClaw returned no response.',
        meta: null,
      };
    }
  } catch (e) {
    console.error('[Agent] OpenClaw error:', e.message);
    agentRuntimeStatus.healthy = false;
    agentRuntimeStatus.lastErrorAt = Date.now();
    agentRuntimeStatus.lastError = e.message;
    return {
      success: false,
      text: `That did not work. ${e.message}`,
      meta: null,
    };
  }
}

/**
 * Extract text from various OpenClaw response shapes.
 */
function extractResponseText(result) {
  if (!result) return '';

  // Shape 1: chat completions format { choices: [{ message: { content } }] }
  const choice = result?.choices?.[0];
  if (choice?.message?.content) {
    const content = choice.message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item?.type === 'text' && typeof item.text === 'string') return item.text;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
  }

  // Shape 2: agent result format { payloads: [{ text }] }
  const payloads = result?.payloads;
  if (Array.isArray(payloads) && payloads.length > 0) {
    return payloads
      .map((p) => p?.text?.trim() || p?.markdown?.trim() || '')
      .filter(Boolean)
      .join('\n\n');
  }

  // Shape 3: direct text field
  if (typeof result?.text === 'string') return result.text.trim();
  if (typeof result?.content === 'string') return result.content.trim();

  return '';
}

/**
 * Register a listener for proactive Gateway events (heartbeat, nudges, etc.).
 * Returns an unsubscribe function.
 */
function onGatewayEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/**
 * Initialize the Gateway connection.
 * Call this at server startup.
 */
function initGateway() {
  if (!USE_MOCK) {
    connect();
  }
}

/**
 * Cleanly disconnect from the Gateway.
 */
function shutdownGateway() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  // Stop reconnecting
  agentRuntimeStatus.reconnectAttempts = Infinity;

  if (gatewaySocket) {
    gatewaySocket.close(1000, 'Clive shutting down');
    gatewaySocket = null;
  }
}

// ---- Helpers ----

function sendState(ws, state) {
  if (ws.readyState === 1) {
    ws.send(createMessage(MessageType.STATE_CHANGE, { state }));
  }
}

function sendTaskStatus(ws, label, progress) {
  if (ws.readyState === 1) {
    ws.send(createMessage(MessageType.TASK_STATUS, { label, progress }));
  }
}

// ---- Mock ----

function mockExecute(ws, userRequest) {
  console.log(`[Agent] Mock execute: "${userRequest}"`);
  sendState(ws, CliveState.WORKING);
  sendTaskStatus(ws, OPENCLAW_STATUS_LABEL, 'OpenClaw not connected (mock mode)');
  agentRuntimeStatus.healthy = true;
  agentRuntimeStatus.lastSuccessAt = Date.now();
  agentRuntimeStatus.lastError = null;

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        success: true,
        text: 'OpenClaw mock mode is active. I can answer, but memory and real actions are not connected yet.',
        meta: null,
      });
    }, 1000);
  });
}

function getAgentRuntimeStatus() {
  return { ...agentRuntimeStatus };
}

module.exports = {
  executeTurn,
  getAgentRuntimeStatus,
  initGateway,
  shutdownGateway,
  onGatewayEvent,
};
