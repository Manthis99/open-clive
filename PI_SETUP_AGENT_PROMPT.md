# Raspberry Pi Setup Agent Prompt

Use this prompt with another coding/setup agent:

---

You are setting up the Raspberry Pi side of **Clive**, a physical AI desk companion.

Project path on the Mac:
`/Users/proctom/Desktop/Create/Project_Clive_Standish`

Key architecture:

- Raspberry Pi runs the local display and wake-word layer
- MacBook runs the Clive host server and OpenClaw
- Pi UI should be served locally on the Pi at `http://localhost:3000`
- Pi browser should run in Chromium kiosk mode
- Pi should connect back to the Mac host server over WebSocket

Your job:

1. Prepare the Pi for production use as the Clive display + wake-word device.
2. Make the Pi boot directly into the Clive UI.
3. Install and configure the dependencies needed for:
   - local Node runtime
   - Chromium kiosk mode
   - optional Porcupine wake word support
4. Set up `systemd` services so Clive auto-starts on boot.
5. Make the setup robust across reboot/network hiccups.
6. Document exactly what you changed and how to operate/recover it.

Important implementation preferences:

- The Pi should serve the UI locally and load it via Chromium kiosk at `localhost:3000`
- The Pi should not depend on a manually opened browser tab
- The Pi should reconnect automatically to the host if the host is unavailable
- The Pi should remain usable even if the host is temporarily offline
- Use a dedicated env/config for the Pi with a configurable host URL
- Prefer recoverable, explicit service management over brittle shell hacks

Please do the following:

1. Inspect the existing `pi-client/` project and understand its current startup path.
2. Add or refine any Pi-specific scripts/config needed for deployment.
3. Create `systemd` units for:
   - the Pi local app service
   - kiosk browser startup
4. Add any helper scripts needed for:
   - waiting for network
   - restarting Chromium cleanly
   - setting environment variables for host connection
5. If Porcupine wake word support needs extra install steps on Pi, document them clearly.
6. Produce a short operator guide covering:
   - install steps on a fresh Pi
   - how to change the host IP/hostname
   - how to restart services
   - how to debug logs
   - what to do if the screen comes up but Clive is disconnected

Constraints:

- Do not redesign the whole product
- Keep the current architecture intact
- Focus on stable Pi deployment
- Do not break the Mac local dev flow
- Prefer small production-ready changes over speculative abstractions

Deliverables:

- the files/scripts/service units you created or changed
- exact commands to install on the Pi
- a validation checklist for first boot
- any assumptions or blockers

---
