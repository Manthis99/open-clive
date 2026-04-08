# Connecting OpenClaw and Clive

## Concept

Clive's desk UI is the **body** — it handles voice, display, and audio.
OpenClaw is the **mind** — it handles conversation, memory, tools, and personality.

They connect over a persistent WebSocket. Every spoken or typed message goes through OpenClaw; Clive just handles the input/output shell.

---

## Step 1 — Set up the Clive agent in OpenClaw

OpenClaw needs a `clive` agent entry in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "clive",
        "name": "clive",
        "workspace": "/Users/YOU/.openclaw/workspace-clive",
        "agentDir": "/Users/YOU/.openclaw/agents/clive/agent",
        "model": "anthropic/claude-haiku-4-5",
        "identity": {
          "name": "Clive Standish",
          "theme": "friend first, strategist second, assistant only when needed"
        }
      }
    ]
  }
}
```

Copy the workspace templates from `openclaw-clive-workspace/` into the path above:

```bash
cp -r openclaw-clive-workspace/* ~/.openclaw/workspace-clive/
```

Key files:
- `SOUL.md` — personality and values
- `IDENTITY.md` — character shape and vibe
- `MEMORY.md` — long-term curated memory
- `USER.md` — human context
- `HEARTBEAT.md` — proactive behavior rules

---

## Step 2 — Find your gateway token

The gateway token is in `~/.openclaw/openclaw.json` under:

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "clawx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

Copy that token value — you'll need it in the next step.

---

## Step 3 — Configure Clive's `.env`

In the project root, copy `.env.example` to `.env` and set:

```env
# Required — points to your running OpenClaw gateway
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=clawx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Which OpenClaw agent to talk to
OPENCLAW_AGENT=clive
OPENCLAW_SESSION_KEY=agent:clive:main

# Disconnect from gateway after 30 min of no turns (prevents overnight API usage)
# Set to 0 to disable. Reconnects automatically on next turn.
OPENCLAW_IDLE_TIMEOUT_MS=1800000

# Optional: fall back to local Claude API if OpenClaw is unavailable
CLIVE_FALLBACK_TO_LOCAL_LLM=1
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Step 4 — Set the heartbeat model to local Ollama

OpenClaw's heartbeat fires periodically in the background. If it's set to a cloud model it will burn API credits overnight even when you're not using Clive. Point it to a local Ollama model instead:

In `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "model": "ollama/qwen3-vl:8b",
        "prompt": "briefly check any blockers pending tasks or reminders"
      }
    }
  }
}
```

Make sure Ollama is running and the model is pulled:

```bash
ollama pull qwen3-vl:8b
```

---

## Step 5 — Start everything

```bash
# Terminal 1: start OpenClaw
openclaw start

# Terminal 2: start Clive host server
npm run dev:host:live

# Terminal 3 (Pi mode): start Pi client
npm run dev:pi
```

Or for desktop-all-in-one:

```bash
npm run dev:desktop
```

---

## How the connection works

```
User speaks / types
      ↓
Clive STT (Whisper) → transcript
      ↓
host-server sends chat.send RPC to OpenClaw Gateway (ws://127.0.0.1:18789)
      ↓
OpenClaw runs turn: memory search → tools → LLM → response
      ↓
Delta events stream back → shown in Clive UI as live task progress
      ↓
Final response → Clive TTS → spoken aloud + displayed as bubble
```

Proactive events (heartbeat nudges, reminders) can also be pushed from OpenClaw → Clive without a user trigger.

---

## Idle gateway disconnect

By default Clive disconnects from the OpenClaw gateway after **30 minutes of inactivity** (`OPENCLAW_IDLE_TIMEOUT_MS=1800000`). This prevents OpenClaw from running session keep-alive cache writes overnight and burning API credits.

When the next turn arrives, Clive reconnects automatically before sending the request. The reconnect typically takes under 1 second on a local machine.

To disable this behaviour (always-on connection): set `OPENCLAW_IDLE_TIMEOUT_MS=0`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD is required` | Set `OPENCLAW_GATEWAY_TOKEN` in `.env` |
| `chat turn timed out` | OpenClaw is slow or offline — check `openclaw status` |
| Response arrives but no audio | Check `ELEVENLABS_API_KEY` or TTS config; or TTS is disabled in Clive settings |
| API credits used overnight | Set `OPENCLAW_IDLE_TIMEOUT_MS=1800000` and set heartbeat to `ollama/qwen3-vl:8b` |
| Fallback responses only | `CLIVE_FALLBACK_TO_LOCAL_LLM=1` is active — OpenClaw connection is failing |
