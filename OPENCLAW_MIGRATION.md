# OpenClaw-Centric Clive Migration

This project is now moving toward an OpenClaw-centric architecture.

## Principle

Clive's desk UI is the body.
OpenClaw is the mind.

That means:

- OpenClaw handles conversational turns and action turns.
- OpenClaw owns long-term memory, personality, and heartbeat behavior.
- The Clive host server remains responsible for STT, TTS, and device/UI state.

## What changed in this repo

- The host server now routes every spoken transcript to OpenClaw first.
- The old local personality engine remains only as a fallback if OpenClaw is unavailable.
- A source-controlled OpenClaw workspace template now lives in `openclaw-clive-workspace/`.

## Recommended next live step

Create or repoint a dedicated OpenClaw agent for Clive and back it with a dedicated workspace, for example:

- agent id: `clive`
- workspace: `~/.openclaw/workspace-clive`

Then copy the files from `openclaw-clive-workspace/` into that workspace and point the host server at:

- `OPENCLAW_AGENT=clive`

## Why this direction

This avoids maintaining two competing personalities and two memory systems.
It also makes heartbeat, memory growth, and continuity native instead of bolted on.
