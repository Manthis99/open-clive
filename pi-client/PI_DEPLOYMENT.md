# Clive Pi Deployment

This Pi setup uses the split architecture:

- `clive-listener/` owns the microphone, wake word detection, and VAD
- `pi-client/` serves the touchscreen UI locally
- Chromium runs the UI in kiosk mode
- `host-server/` stays on the Mac/host machine

## Fresh Pi Install

1. Install system packages:
   `sudo apt update && sudo apt install -y nodejs npm python3-pip python3-venv chromium-browser libportaudio2 portaudio19-dev libatlas-base-dev curl`
2. Clone the repo to the Pi:
   `git clone <your-repo-url> /home/pi/open-clive`
3. Install Node dependencies:
   `cd /home/pi/open-clive && npm run install:all`
4. Install listener dependencies:
   `cd /home/pi/open-clive && python3 -m pip install -r clive-listener/requirements.txt`
5. Copy the env file:
   `sudo cp /home/pi/open-clive/pi-client/deploy/clive-pi.env.example /etc/default/clive-pi`
6. Edit `/etc/default/clive-pi` and set the Mac host IP/hostname.
7. Place your wake word model or recorded templates in [models](./../clive-listener/models).

## Install Services

1. Copy the service files:
   `sudo cp /home/pi/open-clive/pi-client/deploy/systemd/clive-*.service /etc/systemd/system/`
2. Reload systemd:
   `sudo systemctl daemon-reload`
3. Enable services:
   `sudo systemctl enable clive-ui.service clive-listener.service clive-kiosk.service`
4. Start services:
   `sudo systemctl start clive-ui.service clive-listener.service clive-kiosk.service`

## Host Changes

- The Pi UI reads `CLIVE_HOST_HTTP_URL` and `CLIVE_HOST_WS_URL` from `/etc/default/clive-pi`.
- The listener reads `CLIVE_LISTENER_HOST` plus wake-word tuning values from the same file.
- The browser no longer owns the microphone when the listener is connected.

## Useful Commands

- Restart UI: `sudo systemctl restart clive-ui.service`
- Restart listener: `sudo systemctl restart clive-listener.service`
- Restart kiosk: `sudo systemctl restart clive-kiosk.service`
- Tail UI logs: `journalctl -u clive-ui.service -f`
- Tail listener logs: `journalctl -u clive-listener.service -f`
- Tail kiosk logs: `journalctl -u clive-kiosk.service -f`

## First-Boot Checklist

- `clive-ui.service` serves `http://localhost:3000`
- Chromium opens fullscreen to the local UI
- `clive-listener.service` connects to the host websocket
- `/api/status` on the host shows `listenerClients > 0`
- The UI sidebar reports `Listener online`

## If The Screen Loads But Clive Is Disconnected

1. Verify the Mac host is reachable from the Pi.
2. Re-check `CLIVE_HOST_HTTP_URL`, `CLIVE_HOST_WS_URL`, and `CLIVE_LISTENER_HOST` in `/etc/default/clive-pi`.
3. Confirm the host server is running on port `3100`.
4. Inspect listener logs for wake-word model or audio-device errors.
