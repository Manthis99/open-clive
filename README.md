# Open Clive

An AI desk companion with voice, personality, and agency. Runs on a Raspberry Pi with touchscreen, or fully on a GPU-equipped desktop.

## Two Modes

**Pi Mode** -- Raspberry Pi 5 + 5" touchscreen connected to a host machine over WebSocket. The Pi handles the face and mic; the host handles the brain and voice.

**Desktop Mode** -- Everything on one GPU-equipped PC (Windows/Linux). UI in the browser, STT and TTS on the local GPU, personality via OpenClaw or Claude.

## Architecture

```
                   Pi Mode                              Desktop Mode
            +---------------+                     +---------------------+
            | Pi Client     |                     | Desktop Launcher    |
            | (touchscreen) |                     | (browser UI)        |
            +------+--------+                     +----------+----------+
                   | WebSocket                               |
            +------v--------+                     +----------v----------+
            | Host Server   |                     | Host Server (same   |
            | (separate PC) |                     |  process)           |
            +------+--------+                     +----------+----------+
                   |                                         |
    +--------------+--------------+           +--------------+--------------+
    |              |              |           |              |              |
  Whisper       OpenClaw      TTS          Whisper       OpenClaw      CSM TTS
  (STT)         (LLM)      (cloud)        (CUDA)        (LLM)        (CUDA)
```

### Layers

| Layer | What it does | Where it runs |
|-------|-------------|---------------|
| **Presence** | Touchscreen UI, push-to-talk | Pi or browser |
| **Voice** | Speech-to-text, text-to-speech | Host (CPU or GPU) |
| **Personality** | Clive's character, conversation | OpenClaw or Claude API |
| **Agent** | Tools, memory, Notion, Discord, etc. | OpenClaw gateway |

### Directories

| Directory | Purpose |
|-----------|---------|
| `pi-client/` | Pi touchscreen UI (Express + vanilla HTML/CSS/JS) |
| `desktop-client/` | Desktop launcher: serves UI + runs host pipeline on one port |
| `host-server/` | WebSocket server, STT, TTS, personality engine, OpenClaw agent |
| `shared/` | Message schemas, personality system prompt, voice seed audio |
| `clive-listener/` | Python sidecar: always-on wake word detection + voice capture |
| `openclaw-clive-workspace/` | Clive's soul, identity, memory, and heartbeat files for OpenClaw |
| `external/csm/` | Sesame CSM repo (cloned separately, not committed) |

## Quick Start

### Desktop (GPU)

See [DESKTOP_SETUP.md](DESKTOP_SETUP.md) for full instructions.

```bash
git clone https://github.com/Manthis99/open-clive.git
cd open-clive
cp .env.desktop.example .env   # Edit with your API keys
npm run install:all
npm run dev:desktop:gpu
```

Open http://localhost:3100

### Pi Mode

See [PI_SETUP.md](PI_SETUP.md) for full Raspberry Pi instructions.

```bash
# On the Pi:
git clone https://github.com/Manthis99/open-clive.git
cd open-clive
cd pi-client && npm install
cp .env.example .env   # Edit HOST_WS_URL to point at your host machine
npm start
```

```bash
# On the host machine (Mac/PC):
cd open-clive
cd host-server && npm install
cp .env.example .env   # Edit with your API keys
npm start
```

### Mock Mode (no GPU, no API keys)

```bash
npm run dev:desktop
```

Set `MOCK_STT=1`, `MOCK_TTS=1`, `MOCK_LLM=1`, `MOCK_AGENT=1` in `.env` for full mock mode.

## Voice Pipeline

### TTS Engine Priority

1. **CSM** (local GPU) -- context-aware speech, free, requires NVIDIA GPU
2. **Resemble** (cloud) -- if API key set
3. **ElevenLabs** (cloud) -- if API key set
4. **Piper** (local CPU) -- if ONNX model present
5. **Mock** -- silent fallback

### STT

- **faster-whisper** on CUDA (desktop) or CPU (Pi host)
- Persistent process keeps model in VRAM, no cold-start delay

### Wake Word

- Python sidecar (`clive-listener/`) with custom "Hey Clive" ONNX model
- 1D CNN trained on synthetic edge-tts data
- Multi-gate audio filtering (energy, SNR, crest factor, spectral speech)
- Works on desktop (local mic) and Pi (local mic)
- Train your own: `npm run train:wakeword -- --wake-word "hey clive"`

## Personality

Clive's personality is defined in:

- `shared/personality/system-prompt.txt` -- voice pipeline personality
- `openclaw-clive-workspace/SOUL.md` -- full character definition for OpenClaw
- `openclaw-clive-workspace/IDENTITY.md` -- name, manner, values
- `openclaw-clive-workspace/MEMORY.md` -- curated long-term memory
- `openclaw-clive-workspace/USER.md` -- context about the human

When OpenClaw is connected, Clive uses the full workspace with tools, memory, and agency. When it's unavailable, the fallback personality engine uses `system-prompt.txt` with Claude Haiku.

## Environment Variables

See `.env.example` (Pi mode) and `.env.desktop.example` (desktop/GPU mode) for all options.

Key variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Fallback personality engine |
| `OPENCLAW_AGENT` | OpenClaw agent name (default: `clive`) |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for OpenClaw gateway |
| `CSM_ENABLED` | Enable CSM local TTS (`1` or `0`) |
| `CSM_VOICE_SEED` | Path to reference audio for voice identity |
| `WHISPER_DEVICE` | `cuda` or `cpu` |
| `CLOUDFLARE_TUNNEL` | Auto-start Cloudflare tunnel (`1` or `0`) |

## Development

```bash
npm run dev              # Pi client + host server (mock mode)
npm run dev:desktop      # Desktop, mock mode
npm run dev:desktop:gpu  # Desktop, full GPU pipeline
npm run listener:debug   # Wake word listener with debug output
npm run train:wakeword   # Train wake word model
```

## Phase Status

- **Phase 1** (Clive Exists): COMPLETE -- UI, voice pipeline, personality
- **Phase 2** (Clive is Useful): IN PROGRESS -- OpenClaw integration, desktop GPU pipeline
- **Phase 3** (Clive Feels Real): IN PROGRESS -- context-aware voice (CSM), wake word, conversation buffer
- **Phase 4** (Physical Embodiment): NOT STARTED -- servos, LEDs

## License

Private project. Not yet licensed for public use.
