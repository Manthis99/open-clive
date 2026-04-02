# OpenClaw-Centric Clive Architecture

## Principle

Clive's desk UI is the body.
OpenClaw is the mind.

## How it connects

Clive connects to the OpenClaw Gateway over a **persistent bidirectional WebSocket** — the same protocol that Discord, iMessage, and other channel connectors use. This replaces the earlier CLI-based approach (which spawned a new process per turn) and the intermediate HTTP approach.

The connection flow:

1. **Handshake** — Clive connects to `ws://127.0.0.1:18789` as an `operator` with auth token
2. **Chat turns** — User speech is transcribed, sent as an RPC `chat.completions` request, response comes back as a frame
3. **Proactive events** — OpenClaw can push events TO Clive (heartbeat nudges, reminders, proactive messages)
4. **Reconnection** — If the connection drops, exponential backoff reconnect kicks in automatically

## What each side owns

| Clive (body) | OpenClaw (mind) |
|---|---|
| STT (transcription) | Conversational turns |
| TTS (speech synthesis) | Long-term memory |
| UI state + display | Personality + judgment |
| Audio pipeline | Tool execution (Notion, etc.) |
| Device management | Heartbeat behavior |

## Configuration

```env
OPENCLAW_AGENT=clive
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your-token-here
OPENCLAW_SESSION_USER=clive-voice
```

The URL is automatically converted to `ws://` for the WebSocket connection.

## Workspace

Source-controlled workspace templates live in `openclaw-clive-workspace/`. Copy these into your OpenClaw agent's workspace (e.g. `~/.openclaw/workspace-clive`):

- `SOUL.md` — personality and values
- `IDENTITY.md` — character shape and vibe
- `MEMORY.md` — long-term curated memory
- `USER.md` — human context
- `HEARTBEAT.md` — proactive behavior

## Fallback

If OpenClaw is unavailable and `CLIVE_FALLBACK_TO_LOCAL_LLM=1`, Clive falls back to the local Anthropic Claude API for basic responses.
