# Clive — AI Desk Companion

## What This Is
Clive is a physical AI desk companion. Raspberry Pi 5 + 5" touchscreen on the desk, connected to a host machine (MacBook) over WebSocket. Four layers: Presence (Pi), Voice (STT/TTS), Personality (Codex API), Agent (OpenClaw, Phase 2).

## Architecture
- `pi-client/` — Serves touchscreen UI (Express + static HTML/CSS/JS), wake word detection (Porcupine), audio capture
- `host-server/` — WebSocket server, STT (faster-whisper), TTS (ElevenLabs), personality engine (Codex API), agent stub (OpenClaw Phase 2)
- `shared/` — Message schemas, personality system prompt, cached phrases

## Development
```bash
npm run install:all    # Install both pi-client and host-server deps
npm run dev            # Start both in mock mode (no API keys needed)
npm run dev:host       # Host only, mock mode
npm run dev:host:live  # Host only, live APIs (needs keys in .env)
npm run dev:pi         # Pi client only
```

Pi UI: http://localhost:3000
Host WS: ws://localhost:3100

## Mock Mode
Set `MOCK_STT=1`, `MOCK_TTS=1`, `MOCK_LLM=1` to run without API keys. `npm run dev:host` enables all mocks by default.

## Environment Variables
Copy `.env.example` to `.env` and fill in API keys. See that file for all options.

## Key Conventions
- All WebSocket messages use the schema in `shared/schemas/messages.js`
- Personality is defined in `shared/personality/system-prompt.txt` — edit this to change Clive's character
- Pi UI is vanilla HTML/CSS/JS at 800x480 resolution — no framework
- Host server is Node.js with Python sidecar for STT only

## Phase Status
- Phase 1 (Clive Exists): IN PROGRESS — UI, voice pipeline, personality
- Phase 2 (Clive is Useful): NOT STARTED — OpenClaw integration
- Phase 3 (Clive Feels Real): NOT STARTED — latency, interruption
- Phase 4 (Physical Embodiment): NOT STARTED — servos, LEDs
