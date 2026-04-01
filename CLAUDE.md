# Open Clive — AI Desk Companion

## What This Is
Clive is an AI desk companion that runs in two modes:
- **Pi Mode**: Raspberry Pi 5 + 5" touchscreen, connected to a MacBook host over WebSocket
- **Desktop Mode**: Everything on one GPU-equipped PC (Windows/Linux), UI in browser

Four layers: Presence (Pi/Browser), Voice (STT/TTS), Personality (OpenClaw/Claude), Agent (OpenClaw).

## Architecture
- `pi-client/` — Pi touchscreen UI (Express + static HTML/CSS/JS), wake word, audio capture
- `desktop-client/` — Desktop launcher: serves UI + runs host pipeline on one port (GPU-accelerated)
- `host-server/` — WebSocket server, STT (faster-whisper), TTS (CSM/ElevenLabs/Piper), personality engine, OpenClaw agent
- `shared/` — Message schemas, personality system prompt, cached phrases
- `external/csm/` — Sesame CSM (Conversational Speech Model) for context-aware voice generation
- `openclaw-clive-workspace/` — Clive's soul, identity, memory, and heartbeat definitions

## Development

### Pi Mode (original)
```bash
npm run install:all    # Install all deps (pi-client + host-server + desktop-client)
npm run dev            # Start both pi-client and host-server in mock mode
npm run dev:host       # Host only, mock mode
npm run dev:host:live  # Host only, live APIs (needs keys in .env)
npm run dev:pi         # Pi client only
```

Pi UI: http://localhost:3000
Host WS: ws://localhost:3100

### Desktop Mode (GPU)
```bash
npm run dev:desktop       # Desktop, mock mode (no GPU needed)
npm run dev:desktop:gpu   # Desktop, full GPU pipeline (CSM + Whisper)
npm run start:desktop     # Desktop, production
npm run setup:gpu         # Run GPU environment setup script
```

Desktop UI: http://localhost:3100

See `DESKTOP_SETUP.md` for full Windows + GPU setup instructions.

## Mock Mode
Set `MOCK_STT=1`, `MOCK_TTS=1`, `MOCK_LLM=1`, `MOCK_AGENT=1` to run without API keys or GPU.

## Environment Variables
- Pi/Mac: Copy `.env.example` to `.env`
- Desktop/GPU: Copy `.env.desktop.example` to `.env`

## Key Conventions
- All WebSocket messages use the schema in `shared/schemas/messages.js`
- Personality is defined in `shared/personality/system-prompt.txt` and `openclaw-clive-workspace/SOUL.md`
- UI is vanilla HTML/CSS/JS, responsive across phone/tablet/desktop/Pi — no framework
- Host server is Node.js with Python sidecars for STT and TTS
- GPU services (Whisper, CSM) run as persistent Python processes to avoid cold-start delays

## TTS Engine Priority
1. **CSM** (local GPU) — context-aware speech, free, requires NVIDIA GPU
2. **Resemble** (cloud) — if API key set
3. **ElevenLabs** (cloud) — if API key set
4. **Piper** (local CPU) — if ONNX model present
5. **Mock** — no audio output

## Phase Status
- Phase 1 (Clive Exists): COMPLETE — UI, voice pipeline, personality
- Phase 2 (Clive is Useful): IN PROGRESS — OpenClaw integration, Desktop GPU pipeline
- Phase 3 (Clive Feels Real): IN PROGRESS — context-aware voice (CSM), conversation buffer, response shaping
- Phase 4 (Physical Embodiment): NOT STARTED — servos, LEDs
