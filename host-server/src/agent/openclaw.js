/**
 * OpenClaw Agent Integration
 *
 * Clive treats OpenClaw as the primary "mind":
 * every spoken turn is handed to the OpenClaw CLI which communicates
 * with the local Gateway over WebSocket.
 */

const { execFile, exec } = require('child_process');
const path = require('path');
const { MessageType, CliveState, createMessage } = require('../../../shared/schemas/messages');

// Resolve openclaw binary — npm global installs may not be in spawn PATH
const IS_WINDOWS = process.platform === 'win32';
const OPENCLAW_BIN = IS_WINDOWS
  ? path.join(process.env.APPDATA || '', 'npm', 'openclaw.cmd')
  : 'openclaw';

const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'main';
const OPENCLAW_TIMEOUT = parseInt(process.env.OPENCLAW_TIMEOUT || '120', 10);
const OPENCLAW_STATUS_LABEL = process.env.OPENCLAW_STATUS_LABEL || 'Clive is thinking';
const OPENCLAW_SESSION_USER = process.env.OPENCLAW_SESSION_USER || 'clive-voice';

const USE_MOCK = process.env.MOCK_AGENT === '1' || process.env.MOCK_AGENT === 'true';
const agentRuntimeStatus = {
  mode: USE_MOCK ? 'mock' : 'cli',
  agentId: OPENCLAW_AGENT,
  healthy: USE_MOCK,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
};

if (USE_MOCK) {
  console.log('[Agent] Mock mode — OpenClaw disabled');
} else {
  console.log(`[Agent] OpenClaw agent: ${OPENCLAW_AGENT} via CLI`);
}

/**
 * Execute a single spoken turn via OpenClaw.
 * Returns { success, text, meta }
 */
async function executeTurn(ws, userRequest) {
  if (USE_MOCK) {
    return mockExecute(ws, userRequest);
  }

  // Show active reasoning state while OpenClaw handles the turn.
  sendState(ws, CliveState.WORKING);
  sendTaskStatus(ws, OPENCLAW_STATUS_LABEL, userRequest);

  try {
    const result = await runOpenClawTurn(userRequest);
    const responseText = extractResponseText(result);

    if (result.status === 'ok' && responseText) {
      const durationMs = result.result?.meta?.durationMs || 0;
      console.log(`[Agent] Task completed in ${durationMs}ms`);
      agentRuntimeStatus.healthy = true;
      agentRuntimeStatus.lastSuccessAt = Date.now();
      agentRuntimeStatus.lastError = null;

      return {
        success: true,
        text: responseText,
        meta: result.result.meta,
      };
    } else {
      return {
        success: false,
        text: 'That did not work. OpenClaw returned no response.',
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
 * Call OpenClaw via the CLI and return the result.
 * Uses `openclaw agent --agent <id> --message <text> --json --local`
 */
async function runOpenClawTurn(message) {
  console.log(`[Agent] Sending to OpenClaw CLI: "${message.substring(0, 80)}${message.length > 80 ? '...' : ''}"`);

  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--agent', OPENCLAW_AGENT,
      '--message', message,
      '--json',
      '--local',
      '--timeout', String(OPENCLAW_TIMEOUT),
    ];

    if (OPENCLAW_SESSION_USER) {
      args.push('--session-id', OPENCLAW_SESSION_USER);
    }

    // Use exec (shell) on Windows because .cmd files can't be spawned directly
    const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    const command = `"${OPENCLAW_BIN}" ${escapedArgs}`;
    const child = exec(command, {
      timeout: (OPENCLAW_TIMEOUT + 10) * 1000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`CLI error: ${error.message}${stderr ? ' — ' + stderr.trim() : ''}`));
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        const text = payload?.payloads?.[0]?.text || '';
        const durationMs = payload?.meta?.durationMs || 0;
        resolve({
          status: 'ok',
          result: {
            payloads: text ? [{ text: text.trim(), mediaUrl: null }] : [],
            meta: { durationMs, ...(payload?.meta || {}) },
          },
        });
      } catch (parseErr) {
        // stdout might contain non-JSON preamble; try to extract JSON
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const payload = JSON.parse(jsonMatch[0]);
            const text = payload?.payloads?.[0]?.text || '';
            resolve({
              status: 'ok',
              result: {
                payloads: text ? [{ text: text.trim(), mediaUrl: null }] : [],
                meta: payload?.meta || null,
              },
            });
            return;
          } catch { /* fall through */ }
        }
        reject(new Error(`Failed to parse CLI output: ${parseErr.message}`));
      }
    });
  });
}

function extractResponseText(result) {
  const payloads = result?.result?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return '';
  }

  return payloads
    .map((payload) => {
      if (typeof payload?.text === 'string' && payload.text.trim()) {
        return payload.text.trim();
      }

      if (typeof payload?.markdown === 'string' && payload.markdown.trim()) {
        return payload.markdown.trim();
      }

      return '';
    })
    .filter(Boolean)
    .join('\n\n');
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

module.exports = { executeTurn, getAgentRuntimeStatus };
