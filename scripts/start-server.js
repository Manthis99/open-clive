#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const HOST_ENTRY = path.join(ROOT, 'host-server/src/index.js');
const UI_ENTRY = path.join(ROOT, 'pi-client/src/server.js');

const envFromFile = loadEnvFile(ENV_PATH);
const childEnv = { ...envFromFile, ...process.env };

const hostPort = childEnv.HOST_PORT || '3100';
const uiPort = childEnv.PI_UI_PORT || '3000';
const cloudflareEnabled = childEnv.CLOUDFLARE_TUNNEL === '1';
const cloudflareBin = resolveCloudflaredBinary(childEnv);
const cloudflareArgs = parseArgs(childEnv.CLOUDFLARE_TUNNEL_ARGS || 'tunnel run');

const children = [];
let shuttingDown = false;

console.log('[Server] Clive server launcher starting...');
console.log(`[Server] Host pipeline: http://localhost:${hostPort}`);
console.log(`[Server] Web UI: http://localhost:${uiPort}`);
console.log(`[Server] Cloudflare tunnel: ${cloudflareEnabled ? 'enabled' : 'disabled'}`);

startChild('host', process.execPath, [HOST_ENTRY], {
  cwd: ROOT,
  env: childEnv,
});

startChild('ui', process.execPath, [UI_ENTRY], {
  cwd: path.join(ROOT, 'pi-client'),
  env: childEnv,
});

if (cloudflareEnabled) {
  if (cloudflareBin) {
    startChild('tunnel', cloudflareBin, cloudflareArgs, {
      cwd: ROOT,
      env: childEnv,
    });
  } else {
    console.log('[Server] Cloudflare tunnel enabled, but no cloudflared binary was found. Set CLOUDFLARED_BIN or install cloudflared.');
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function startChild(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const record = { name, child };
  children.push(record);

  child.stdout.on('data', (chunk) => {
    process.stdout.write(prefixLines(name, chunk.toString()));
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(prefixLines(name, chunk.toString()));
  });

  child.on('error', (error) => {
    console.error(`[Server] Failed to start ${name}: ${error.message}`);
    if (name !== 'tunnel') {
      shutdown(1);
    }
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    const detail = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`[Server] ${name} exited with ${detail}`);

    if (name === 'tunnel') {
      return;
    }

    shutdown(code || 1);
  });
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('[Server] Shutting down child processes...');
  for (const { child } of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(exitCode);
  }, 3000).unref();
}

function prefixLines(name, text) {
  const prefix = `[${name}] `;
  const normalized = text.replace(/\r?\n$/, '');
  const lines = normalized.split(/\r?\n/);
  return lines.map((line) => `${prefix}${line}\n`).join('');
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const result = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function resolveCloudflaredBinary(env) {
  if (env.CLOUDFLARED_BIN) {
    return path.isAbsolute(env.CLOUDFLARED_BIN)
      ? env.CLOUDFLARED_BIN
      : path.join(ROOT, env.CLOUDFLARED_BIN);
  }

  const bundledWindowsBinary = path.join(ROOT, 'cloudflared.exe');
  if (fs.existsSync(bundledWindowsBinary)) {
    return bundledWindowsBinary;
  }

  return 'cloudflared';
}

function parseArgs(value) {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
