# Clive Desktop — Windows + GPU Setup Guide

Run Clive entirely on a local PC with an NVIDIA GPU. No Raspberry Pi needed — the UI runs in your browser, everything else runs locally.

## Hardware Requirements

- **GPU**: NVIDIA with 6+ GB VRAM (tested on RTX 2080 TI, 11GB)
- **CPU**: Any modern multi-core (helps with OpenClaw and audio processing)
- **RAM**: 16GB+ recommended
- **OS**: Windows 10/11 (also works on Linux)

## VRAM Budget

| Component | VRAM |
|-----------|------|
| faster-whisper `small` (STT) | ~500 MB |
| CSM-1B + Mimi (TTS) | ~4,000 MB |
| Generation buffers | ~1,500 MB |
| **Total** | **~6 GB** |

Leaves ~5GB free on a 2080 TI. Comfortable.

## Quick Start

### 1. Prerequisites

Install these first:
- [Python 3.10](https://www.python.org/downloads/) (3.10 recommended for CSM)
- [Node.js 18+](https://nodejs.org/)
- [NVIDIA CUDA Toolkit 12.x](https://developer.nvidia.com/cuda-downloads)
- [Git](https://git-scm.com/)
- [ffmpeg](https://ffmpeg.org/download.html) (optional, for audio tempo adjustment)

Verify CUDA is working:
```bash
nvidia-smi
```

### 2. Clone the Repo

```bash
git clone https://github.com/Manthis99/open-clive.git
cd open-clive
```

### 3. Clone CSM (External Dependency)

```bash
mkdir -p external
cd external
git clone https://github.com/SesameAILabs/csm.git
cd ..
```

### 4. Set Up Python GPU Environment

```bash
python desktop-client/setup-gpu.py
```

This creates a `.venv/` and installs:
- PyTorch 2.4 with CUDA 12.4
- faster-whisper (STT)
- HuggingFace Transformers 4.52+ (CSM TTS)
- All CSM dependencies

### 5. Install Node.js Dependencies

```bash
npm run install:all
```

### 6. Configure Environment

```bash
copy .env.desktop.example .env
```

Edit `.env` and add your API keys:
- `OPENCLAW_GATEWAY_TOKEN` — if using OpenClaw
- `ANTHROPIC_API_KEY` — for fallback personality
- `ELEVENLABS_API_KEY` — optional fallback TTS

### 7. HuggingFace Login (First Time Only)

CSM-1B requires access to Llama-3.2-1B. Log in to download:

```bash
.venv\Scripts\huggingface-cli login
```

Accept the Llama 3.2 license at: https://huggingface.co/meta-llama/Llama-3.2-1B

### 8. Run Clive Desktop

**With GPU (full pipeline):**
```bash
npm run dev:desktop:gpu
```

**Mock mode (no GPU needed, for testing UI):**
```bash
npm run dev:desktop
```

Then open: **http://localhost:3100**

## How It Works

```
Browser (http://localhost:3100)
    ↕ WebSocket
Desktop Server (launcher.js)
    │
    ├─ STT ──→ whisper_server.py (persistent, GPU)
    │            faster-whisper small, ~500MB VRAM
    │
    ├─ Mind ──→ OpenClaw Gateway (http://127.0.0.1:18789)
    │            or Claude API fallback
    │
    └─ TTS ──→ csm_server.py (persistent, GPU)
                 CSM-1B, ~4GB VRAM
                 Context-aware speech generation
```

Both Python processes start once and stay resident in GPU VRAM. No cold-start delay on each interaction.

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_DEVICE` | `cuda` | STT device: `cuda` or `cpu` |
| `WHISPER_MODEL` | `small` | Whisper model size: `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_PERSISTENT` | `1` | Keep Whisper loaded in VRAM (`1`) or spawn per-call (`0`) |
| `CSM_ENABLED` | `1` | Use CSM for TTS (`1`) or fall back to ElevenLabs/Piper (`0`) |
| `CSM_DEVICE` | `cuda` | CSM device |
| `CSM_MAX_CONTEXT_TURNS` | `5` | Conversation turns to feed CSM for context-aware speech |
| `CSM_MAX_AUDIO_LENGTH_MS` | `15000` | Max audio generation length |
| `CSM_SPEAKER_ID` | `0` | CSM speaker identity |

## Troubleshooting

### CUDA not found
- Run `nvidia-smi` to verify drivers
- Make sure CUDA toolkit matches your PyTorch version (12.4)
- On Windows, ensure CUDA bin is in PATH

### CSM model download fails
- Make sure you've run `huggingface-cli login`
- Accept the Llama 3.2 license on HuggingFace
- Check disk space (~5GB for model files)

### Out of VRAM
- Reduce Whisper model size: `WHISPER_MODEL=tiny` (~75MB)
- Disable persistent mode: `WHISPER_PERSISTENT=0` (model unloads between calls)
- Disable CSM and use ElevenLabs: `CSM_ENABLED=0`

### Triton errors on Windows
- Set `NO_TORCH_COMPILE=1` (already set by default)
- Install `pip install triton-windows` if needed

## Differences from Pi Version

| Feature | Pi Version | Desktop Version |
|---------|-----------|-----------------|
| UI device | Raspberry Pi touchscreen | Any browser |
| STT | faster-whisper on CPU | faster-whisper on GPU (5-10x faster) |
| TTS | ElevenLabs cloud | CSM local GPU (free, context-aware) |
| LLM | OpenClaw / Claude API | Same (OpenClaw / Claude API) |
| Wake word | openWakeWord on Pi | Keyboard/PTT in browser |
| Server | Two processes (pi-client + host-server) | Single process (desktop launcher) |
