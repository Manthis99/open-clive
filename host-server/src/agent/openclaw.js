/**
 * OpenClaw Agent Integration — Gateway WebSocket Client
 *
 * Long-term transport:
 *   - Persistent Gateway WebSocket connection
 *   - Official connect.challenge + device-signature flow
 *   - Device token caching for smoother reconnects
 *   - chat.send + chat events for conversational turns
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const { MessageType, CliveState, createMessage } = require('../../../shared/schemas/messages');

const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'main';
const OPENCLAW_TIMEOUT = parseInt(process.env.OPENCLAW_TIMEOUT || '120', 10);
const OPENCLAW_STATUS_LABEL = process.env.OPENCLAW_STATUS_LABEL || 'Clive is thinking';
const OPENCLAW_GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/+$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_GATEWAY_PASSWORD = process.env.OPENCLAW_GATEWAY_PASSWORD;
const OPENCLAW_RUNTIME_STYLE_PROMPT = process.env.OPENCLAW_RUNTIME_STYLE_PROMPT?.trim() || '';
const OPENCLAW_CLIENT_ID = process.env.OPENCLAW_CLIENT_ID || 'openclaw-control-ui';
const OPENCLAW_CLIENT_VERSION = process.env.OPENCLAW_CLIENT_VERSION || '0.2.0';
const OPENCLAW_CLIENT_MODE = process.env.OPENCLAW_CLIENT_MODE || 'webchat';
const OPENCLAW_DEVICE_FAMILY = process.env.OPENCLAW_DEVICE_FAMILY || 'desktop';
const OPENCLAW_DEVICE_AUTH_VERSION = process.env.OPENCLAW_DEVICE_AUTH_VERSION || 'v2';
const OPENCLAW_DEBUG_FRAMES =
  process.env.OPENCLAW_DEBUG_FRAMES === '1' || process.env.OPENCLAW_DEBUG_FRAMES === 'true';
const OPENCLAW_SCOPES = parseScopes(process.env.OPENCLAW_SCOPES) || ['operator.admin'];
const OPENCLAW_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || `agent:${OPENCLAW_AGENT}:main`;
const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_CLIENT_STATE_DIR ||
  path.join(os.homedir(), '.openclaw', 'clive-gateway-client');
const OPENCLAW_IDLE_TIMEOUT_MS = parseInt(process.env.OPENCLAW_IDLE_TIMEOUT_MS || '1800000', 10);
const OPENCLAW_IDENTITY_PATH = path.join(OPENCLAW_STATE_DIR, 'identity.json');
const OPENCLAW_DEVICE_AUTH_PATH = path.join(OPENCLAW_STATE_DIR, 'device-auth.json');
const GATEWAY_WS_URL = OPENCLAW_GATEWAY_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
const CONNECT_CHALLENGE_TIMEOUT_MS = 2000;
const DEVICE_SIGNATURE_SKEW_MS = 120000;
const TICK_FALLBACK_MS = 30000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const USE_MOCK = process.env.MOCK_AGENT === '1' || process.env.MOCK_AGENT === 'true';

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

const eventListeners = new Set();
const pendingRequests = new Map();
const pendingRuns = new Map();

let gatewaySocket = null;
let connectNonce = null;
let connectSent = false;
let connectTimer = null;
let reconnectTimer = null;
let tickTimer = null;
let idleTimer = null;
let lastTickAt = null;
let helloSnapshot = null;
let pendingConnect = null;
let pendingConnectError = null;
let lastSeq = null;

if (USE_MOCK) {
  console.log('[Agent] Mock mode — OpenClaw disabled');
} else {
  console.log(`[Agent] OpenClaw agent: ${OPENCLAW_AGENT} via Gateway WebSocket at ${GATEWAY_WS_URL}`);
}

function parseScopes(raw) {
  if (!raw) return null;
  const scopes = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function loadOrCreateDeviceIdentity(filePath = OPENCLAW_IDENTITY_PATH) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId !== parsed.deviceId) {
          parsed.deviceId = derivedId;
          ensureDir(filePath);
          fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
        }
        return {
          deviceId: derivedId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {}

  const identity = generateIdentity();
  ensureDir(filePath);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem,
        createdAtMs: Date.now(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return identity;
}

function readDeviceAuthStore(filePath = OPENCLAW_DEVICE_AUTH_PATH) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.deviceId !== 'string') return null;
    if (!parsed.tokens || typeof parsed.tokens !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadDeviceAuthToken({ deviceId, role }, filePath = OPENCLAW_DEVICE_AUTH_PATH) {
  const store = readDeviceAuthStore(filePath);
  if (!store || store.deviceId !== deviceId) return null;
  const entry = store.tokens?.[role];
  return entry && typeof entry.token === 'string' ? entry : null;
}

function storeDeviceAuthToken({ deviceId, role, token, scopes }, filePath = OPENCLAW_DEVICE_AUTH_PATH) {
  ensureDir(filePath);
  const existing = readDeviceAuthStore(filePath);
  const next = {
    version: 1,
    deviceId,
    tokens:
      existing && existing.deviceId === deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  next.tokens[role] = {
    token,
    role,
    scopes: Array.isArray(scopes) ? [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort() : [],
    updatedAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function clearDeviceAuthToken({ deviceId, role }, filePath = OPENCLAW_DEVICE_AUTH_PATH) {
  const store = readDeviceAuthStore(filePath);
  if (!store || store.deviceId !== deviceId || !store.tokens?.[role]) return;
  delete store.tokens[role];
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function buildDeviceAuthPayload(params) {
  if (OPENCLAW_DEVICE_AUTH_VERSION === 'v3') {
    return [
      'v3',
      params.deviceId,
      params.clientId,
      params.clientMode,
      params.role,
      params.scopes.join(','),
      String(params.signedAtMs),
      params.token ?? '',
      params.nonce,
      params.platform,
      params.deviceFamily,
    ].join('|');
  }

  return [
    'v2',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
  ].join('|');
}

function signDevicePayload(privateKeyPem, payload) {
  return base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem))
  );
}

function createRequestId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function currentPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

function currentLocale() {
  const envLocale =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || '';
  const normalized = envLocale.split('.')[0].replace('_', '-').trim();
  return normalized || 'en-US';
}

function buildUserAgent() {
  return `${OPENCLAW_CLIENT_ID}/${OPENCLAW_CLIENT_VERSION}`;
}

function connect() {
  if (USE_MOCK || gatewaySocket) return;

  gatewaySocket = new WebSocket(GATEWAY_WS_URL, {
    headers: {
      Origin: OPENCLAW_GATEWAY_URL,
      'User-Agent': buildUserAgent(),
    },
  });
  gatewaySocket.on('open', handleSocketOpen);
  gatewaySocket.on('message', handleSocketMessage);
  gatewaySocket.on('close', handleSocketClose);
  gatewaySocket.on('error', handleSocketError);
}

function handleSocketOpen() {
  connectNonce = null;
  connectSent = false;
  pendingConnectError = null;

  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (connectSent || !gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) return;
    const error = new Error('gateway connect challenge timeout');
    pendingConnectError = error;
    agentRuntimeStatus.lastError = error.message;
    agentRuntimeStatus.lastErrorAt = Date.now();
    gatewaySocket.close(1008, 'connect challenge timeout');
  }, CONNECT_CHALLENGE_TIMEOUT_MS);
}

function handleSocketMessage(data) {
  let parsed;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (OPENCLAW_DEBUG_FRAMES) {
    console.log('[Agent][Gateway<=]', JSON.stringify(parsed));
  }

  if (parsed.type === 'event') {
    handleEventFrame(parsed);
    return;
  }

  if (parsed.type === 'res') {
    handleResponseFrame(parsed);
  }
}

function handleEventFrame(frame) {
  if (frame.event === 'connect.challenge') {
    const nonce = typeof frame.payload?.nonce === 'string' ? frame.payload.nonce.trim() : '';
    if (!nonce) {
      const error = new Error('gateway connect challenge missing nonce');
      pendingConnectError = error;
      agentRuntimeStatus.lastError = error.message;
      agentRuntimeStatus.lastErrorAt = Date.now();
      gatewaySocket?.close(1008, 'connect challenge missing nonce');
      return;
    }
    connectNonce = nonce;
    sendConnect();
    return;
  }

  if (typeof frame.seq === 'number') {
    if (lastSeq !== null && frame.seq > lastSeq + 1) {
      agentRuntimeStatus.lastError = `gateway event gap: expected ${lastSeq + 1}, received ${frame.seq}`;
      agentRuntimeStatus.lastErrorAt = Date.now();
    }
    lastSeq = frame.seq;
  }

  if (frame.event === 'tick') {
    lastTickAt = Date.now();
  }

  if (frame.event === 'chat') {
    handleChatEvent(frame.payload);
  }

  for (const listener of eventListeners) {
    try {
      listener(frame);
    } catch (error) {
      console.error('[Agent] Event listener error:', error.message);
    }
  }
}

function handleResponseFrame(frame) {
  const pending = pendingRequests.get(frame.id);
  if (!pending) return;

  if (pending.expectInFlight && frame.ok && frame.payload?.status === 'started') {
    pendingRequests.delete(frame.id);
    clearTimeout(pending.timer);
    pending.started = true;
    pending.resolve(frame.payload);
    return;
  }

  pendingRequests.delete(frame.id);
  clearTimeout(pending.timer);

  if (frame.ok) {
    pending.resolve(frame.payload);
    return;
  }

  const error = new Error(frame.error?.message || 'gateway request failed');
  error.gatewayCode = frame.error?.code || null;
  error.gatewayDetails = frame.error?.details || null;
  pending.reject(error);
}

function handleSocketClose(code, reason) {
  const reasonText = reason ? reason.toString() : 'no reason';
  const closeError = pendingConnectError || new Error(`gateway closed (${code}): ${reasonText}`);

  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  gatewaySocket = null;
  connectNonce = null;
  connectSent = false;
  helloSnapshot = null;
  lastTickAt = null;
  agentRuntimeStatus.connected = false;
  agentRuntimeStatus.healthy = false;
  agentRuntimeStatus.lastError = closeError.message;
  agentRuntimeStatus.lastErrorAt = Date.now();

  if (pendingConnect) {
    pendingConnect.reject(closeError);
    pendingConnect = null;
  }

  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(closeError);
  }
  pendingRequests.clear();

  for (const run of pendingRuns.values()) {
    clearTimeout(run.timer);
    run.reject(closeError);
  }
  pendingRuns.clear();

  if (!USE_MOCK && !reconnectTimer) {
    const delay = Math.min(Math.max(1000, Math.pow(2, agentRuntimeStatus.reconnectAttempts) * 1000), 30000);
    agentRuntimeStatus.reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }
}

function handleSocketError(error) {
  agentRuntimeStatus.lastError = error.message;
  agentRuntimeStatus.lastErrorAt = Date.now();
}

function sendConnect() {
  if (connectSent || !gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) return;
  if (!connectNonce) {
    const error = new Error('gateway connect challenge missing nonce');
    pendingConnectError = error;
    gatewaySocket.close(1008, 'connect challenge missing nonce');
    return;
  }

  connectSent = true;
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  const role = 'operator';
  const deviceIdentity = loadOrCreateDeviceIdentity();
  const explicitGatewayToken = OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
  const storedDeviceToken = loadDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role })?.token;
  const authToken = explicitGatewayToken || storedDeviceToken || undefined;
  const authPassword = OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
  const signedAtMs = Date.now();
  const platform = currentPlatform();

  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: OPENCLAW_CLIENT_ID,
    clientMode: OPENCLAW_CLIENT_MODE,
    role,
    scopes: OPENCLAW_SCOPES,
    signedAtMs,
    token: authToken || null,
    nonce: connectNonce,
    platform,
    deviceFamily: OPENCLAW_DEVICE_FAMILY,
  });

  const device = {
    id: deviceIdentity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
    signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce: connectNonce,
  };

  request('connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: OPENCLAW_CLIENT_ID,
      version: OPENCLAW_CLIENT_VERSION,
      platform,
      mode: OPENCLAW_CLIENT_MODE,
    },
    caps: [],
    commands: [],
    permissions: {},
    role,
    scopes: OPENCLAW_SCOPES,
    auth: authToken || authPassword ? { token: authToken, password: authPassword } : undefined,
    locale: currentLocale(),
    userAgent: buildUserAgent(),
    device,
  })
    .then((helloOk) => {
      helloSnapshot = helloOk;
      agentRuntimeStatus.connected = true;
      agentRuntimeStatus.healthy = true;
      agentRuntimeStatus.lastError = null;
      agentRuntimeStatus.reconnectAttempts = 0;
      if (helloOk?.auth?.deviceToken) {
        storeDeviceAuthToken({
          deviceId: deviceIdentity.deviceId,
          role: helloOk.auth.role || role,
          token: helloOk.auth.deviceToken,
          scopes: helloOk.auth.scopes || [],
        });
      }
      startTickWatch(helloOk?.policy?.tickIntervalMs);
      if (pendingConnect) {
        pendingConnect.resolve(helloOk);
        pendingConnect = null;
      }
    })
    .catch((error) => {
      pendingConnectError = error;
      if (error.gatewayCode === 'NOT_PAIRED') {
        clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
      }
      if (pendingConnect) {
        pendingConnect.reject(error);
        pendingConnect = null;
      }
      gatewaySocket?.close(1008, 'connect failed');
    });
}

function startTickWatch(intervalMs) {
  const tickIntervalMs =
    typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : TICK_FALLBACK_MS;
  lastTickAt = Date.now();

  if (tickTimer) {
    clearInterval(tickTimer);
  }

  tickTimer = setInterval(() => {
    if (!lastTickAt || !gatewaySocket) return;
    if (Date.now() - lastTickAt > tickIntervalMs * 2) {
      gatewaySocket.close(4000, 'tick timeout');
    }
  }, Math.max(1000, tickIntervalMs));
}

function ensureConnected() {
  if (USE_MOCK) return Promise.resolve(null);
  if (gatewaySocket && gatewaySocket.readyState === WebSocket.OPEN && agentRuntimeStatus.connected) {
    return Promise.resolve(helloSnapshot);
  }
  if (pendingConnect) {
    return pendingConnect.promise;
  }

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  pendingConnect = {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };

  connect();
  return promise;
}

function request(method, params, options = {}) {
  if (!gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('gateway not connected'));
  }

  return new Promise((resolve, reject) => {
    const id = createRequestId(method);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`${method} timed out after ${OPENCLAW_TIMEOUT}s`));
    }, OPENCLAW_TIMEOUT * 1000);

    pendingRequests.set(id, {
      id,
      resolve,
      reject,
      timer,
      expectInFlight: options.expectInFlight === true,
      started: false,
    });

    const frame = {
      type: 'req',
      id,
      method,
      params,
    };

    if (OPENCLAW_DEBUG_FRAMES) {
      console.log('[Agent][Gateway=>]', JSON.stringify(frame));
    }

    gatewaySocket.send(JSON.stringify(frame));
  });
}

function buildGatewayMessage(userRequest) {
  if (!OPENCLAW_RUNTIME_STYLE_PROMPT) {
    return userRequest;
  }

  return `${OPENCLAW_RUNTIME_STYLE_PROMPT}\n\nUser: ${userRequest}`;
}

async function executeTurn(ws, userRequest) {
  if (USE_MOCK) {
    return mockExecute(ws, userRequest);
  }

  resetIdleTimer();

  if (!OPENCLAW_GATEWAY_TOKEN && !OPENCLAW_GATEWAY_PASSWORD) {
    const error = 'OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD is required';
    agentRuntimeStatus.lastError = error;
    agentRuntimeStatus.lastErrorAt = Date.now();
    return {
      success: false,
      text: error,
      meta: null,
    };
  }

  sendState(ws, CliveState.WORKING);
  sendTaskStatus(ws, OPENCLAW_STATUS_LABEL, userRequest);

  try {
    if (OPENCLAW_DEBUG_FRAMES) {
      console.log('[Agent] Waiting for gateway connect');
    }
    await ensureConnected();
    if (OPENCLAW_DEBUG_FRAMES) {
      console.log('[Agent] Gateway connected, sending chat.send');
    }
    const runId = createRequestId('clive-turn');
    const waitForReply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRuns.delete(runId);
        reject(new Error(`chat turn timed out after ${OPENCLAW_TIMEOUT}s`));
      }, OPENCLAW_TIMEOUT * 1000);

      pendingRuns.set(runId, {
        resolve,
        reject,
        timer,
        deltaText: '',
        ws,
      });
    });

    await request(
      'chat.send',
      {
        sessionKey: OPENCLAW_SESSION_KEY,
        message: buildGatewayMessage(userRequest),
        deliver: false,
        idempotencyKey: runId,
      },
      { expectInFlight: true }
    );

    const result = await waitForReply;
    agentRuntimeStatus.healthy = true;
    agentRuntimeStatus.lastSuccessAt = Date.now();
    agentRuntimeStatus.lastError = null;
    return result;
  } catch (error) {
    const message = error.message || 'OpenClaw Gateway request failed';
    console.error('[Agent] OpenClaw error:', message);
    agentRuntimeStatus.healthy = false;
    agentRuntimeStatus.lastError = message;
    agentRuntimeStatus.lastErrorAt = Date.now();
    return {
      success: false,
      text: `That did not work. ${message}`,
      meta: null,
    };
  }
}

function handleChatEvent(payload) {
  const runId = typeof payload?.runId === 'string' ? payload.runId : null;
  if (!runId) return;

  const pending = pendingRuns.get(runId);
  if (!pending) return;

  const state = typeof payload?.state === 'string' ? payload.state : null;
  if (state === 'delta') {
    const delta = extractResponseText(payload.message);
    if (delta) {
      pending.deltaText = delta.length >= pending.deltaText.length ? delta : pending.deltaText;
      sendTaskStatus(pending.ws, OPENCLAW_STATUS_LABEL, pending.deltaText);
    }
    return;
  }

  if (state === 'final') {
    clearTimeout(pending.timer);
    pendingRuns.delete(runId);
    pending.resolve({
      success: true,
      text: extractResponseText(payload.message) || pending.deltaText || '',
      meta: { runId, sessionKey: payload.sessionKey || OPENCLAW_SESSION_KEY },
    });
    return;
  }

  if (state === 'aborted') {
    clearTimeout(pending.timer);
    pendingRuns.delete(runId);
    pending.reject(new Error('chat turn aborted'));
    return;
  }

  if (state === 'error') {
    clearTimeout(pending.timer);
    pendingRuns.delete(runId);
    pending.reject(new Error(payload?.errorMessage || 'chat turn failed'));
  }
}

function extractResponseText(result) {
  if (!result) return '';

  const directText = typeof result?.text === 'string' ? result.text.trim() : '';
  if (directText) return directText;

  const content = result?.content;
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

  const choice = result?.choices?.[0];
  if (choice?.message?.content) {
    if (typeof choice.message.content === 'string') return choice.message.content.trim();
    if (Array.isArray(choice.message.content)) {
      return choice.message.content
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

  return '';
}

function onGatewayEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (OPENCLAW_IDLE_TIMEOUT_MS <= 0) return;
  
  idleTimer = setTimeout(() => {
    console.log(`[Agent] Gateway idle timeout reached (${OPENCLAW_IDLE_TIMEOUT_MS}ms), shutting down connection`);
    shutdownGateway();
  }, OPENCLAW_IDLE_TIMEOUT_MS);
}

function initGateway() {
  if (USE_MOCK) return;
  ensureConnected().catch((error) => {
    agentRuntimeStatus.lastError = error.message;
    agentRuntimeStatus.lastErrorAt = Date.now();
    console.warn('[Agent] Gateway connect pending:', error.message);
  });
  resetIdleTimer();
}

function shutdownGateway() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (gatewaySocket) {
    gatewaySocket.close(1000, 'Clive shutting down');
    gatewaySocket = null;
  }
  agentRuntimeStatus.connected = false;
}

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

function mockExecute(ws, userRequest) {
  console.log(`[Agent] Mock execute: "${userRequest}"`);
  sendState(ws, CliveState.WORKING);
  sendTaskStatus(ws, OPENCLAW_STATUS_LABEL, 'OpenClaw not connected (mock mode)');
  agentRuntimeStatus.healthy = true;
  agentRuntimeStatus.connected = true;
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
