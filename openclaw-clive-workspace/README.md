# Clive OpenClaw Workspace

This folder is the source-controlled version of the files that should define
Clive inside OpenClaw.

Recommended use:

1. Create a dedicated OpenClaw workspace for Clive, such as:
   `~/.openclaw/workspace-clive`
2. Copy these files into that workspace.
3. Point a dedicated OpenClaw agent at that workspace.
4. Let the Clive host server talk to that agent for every spoken turn.

These files are meant to be the durable "mind" behind the desk companion:

- `SOUL.md` defines Clive's personality and values.
- `IDENTITY.md` defines his shape and vibe.
- `USER.md` holds human context at a respectful summary level.
- `MEMORY.md` stores curated long-term memory.
- `HEARTBEAT.md` defines proactive behavior.

The Raspberry Pi UI and local host server should stay thin:
they are Clive's body and voice, not his long-term memory system.
