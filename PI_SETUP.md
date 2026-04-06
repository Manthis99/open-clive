# Clive Pi Setup Guide

Run Clive on a Raspberry Pi 5 with a 5" touchscreen. The Pi handles the UI and microphone; a separate host machine handles STT, TTS, and the LLM.

## Hardware

- **Raspberry Pi 5** (4GB+ RAM recommended)
- **5" touchscreen** (HDMI or DSI)
- **USB microphone** or **I2S mic** (e.g., INMP441)
- **Speaker** (3.5mm, Bluetooth, or I2S amp like MAX98357A)
- **Host machine** on the same network (Mac, PC, or Linux box with GPU)

## Network Layout

```
[Pi + touchscreen + mic + speaker]
        |
        | WebSocket (ws://HOST_IP:3100)
        |
[Host machine (runs STT, TTS, LLM)]
```

## Pi Setup

### 1. Install OS

Use Raspberry Pi Imager to flash **Raspberry Pi OS (64-bit)** with desktop.

Enable SSH in the imager for headless setup.

### 2. Clone the Repo

```bash
git clone https://github.com/Manthis99/open-clive.git
cd open-clive
```

### 3. Install Pi Client

```bash
cd pi-client
npm install
```

The optional Picovoice dependencies may fail on Pi -- that's fine. The client works without them (wake word runs separately via the listener sidecar).

### 4. Configure Environment

```bash
cp .env.example .env
nano .env
```

Set `HOST_WS_URL` to point at your host machine:
```
HOST_WS_URL=ws://192.168.1.100:3100
```

Replace `192.168.1.100` with your host machine's local IP.

### 5. Start the Pi Client

```bash
cd pi-client
npm start
```

Open the Pi's browser to `http://localhost:3000` (or it auto-opens on the touchscreen).

### 6. (Optional) Wake Word Listener

The wake word listener runs as a Python sidecar, always listening for "Hey Clive":

> [!IMPORTANT]
> **Wake Word Model Required**
> The `clive-listener/models/` directory is empty by default because we do not distribute the `.onnx` weight files. The listener will fail silently if no model is present. You **must** train and generate this file before running the listener!

```bash
# 1. Install Python dependencies
pip install -r clive-listener/requirements.txt

# 2. Train the wake word model (requires ~1-2 mins on a host machine)
cd clive-listener/tools
python train_wake_word.py --wake-word "hey clive" --epochs 2000

# This outputs `./models/hey_clive.onnx` automatically.
# 3. Run the listener
cd ..
python listener.py --host ws://HOST_IP:3100 --wake-word "hey clive" --sensitivity 7 --debug
```

The listener captures audio from the Pi's microphone, detects "Hey Clive", then sends audio to the host server via WebSocket.

### 7. Auto-Start on Boot

Create a systemd service for the Pi client:

```bash
sudo nano /etc/systemd/system/clive-ui.service
```

```ini
[Unit]
Description=Clive Pi UI
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/open-clive/pi-client
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable clive-ui
sudo systemctl start clive-ui
```

Optionally create a second service for the listener:

```bash
sudo nano /etc/systemd/system/clive-listener.service
```

```ini
[Unit]
Description=Clive Wake Word Listener
After=network.target clive-ui.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/open-clive/clive-listener
ExecStart=/usr/bin/python3 listener.py --host ws://HOST_IP:3100 --wake-word "hey clive" --sensitivity 7
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Optionally create a third service to launch the touchscreen browser in **Kiosk Mode**:

```bash
sudo nano /etc/systemd/system/clive-kiosk.service
```

```ini
[Unit]
Description=Clive Kiosk Browser
After=graphical.target clive-ui.service

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
ExecStart=/usr/bin/chromium-browser --kiosk --incognito --disable-infobars --noerrdialogs http://localhost:3000
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
```

Then enable and start everything:
```bash
sudo systemctl enable clive-ui clive-listener clive-kiosk
sudo systemctl start clive-ui clive-listener clive-kiosk
```

## Host Setup

The host machine runs the heavy lifting. This can be any Mac, PC, or Linux box on the same network.

### Without GPU (cloud TTS)

```bash
cd open-clive
cd host-server && npm install
cp .env.example .env
# Edit .env: add ANTHROPIC_API_KEY and optionally ELEVENLABS_API_KEY
npm start
```

### With GPU (local CSM TTS)

See [DESKTOP_SETUP.md](DESKTOP_SETUP.md) for GPU setup. The desktop launcher also works as a Pi host -- just make sure `HOST_PORT=3100` is set and the Pi can reach the host IP.

## Audio Setup on Pi

### USB Microphone

Most USB mics work out of the box. Check:
```bash
arecord -l   # List capture devices
aplay -l     # List playback devices
```

### I2S Microphone (INMP441)

Add to `/boot/config.txt`:
```
dtoverlay=googlevoicehat-soundcard
```

Or for generic I2S:
```
dtoverlay=i2s-mmap
```

### Test Audio

```bash
# Record 5 seconds
arecord -d 5 -f S16_LE -r 16000 test.wav

# Play it back
aplay test.wav
```

## Troubleshooting

### Pi can't connect to host
- Check both machines are on the same network
- Verify host IP: `hostname -I` on the host
- Make sure port 3100 isn't blocked by firewall
- Test: `curl http://HOST_IP:3100` from the Pi

### No audio from Pi
- Check `aplay -l` for available devices
- Set default audio device in `/etc/asound.conf` if needed
- For Bluetooth speakers, pair first via `bluetoothctl`

### Listener can't access microphone
- Check `python -c "import sounddevice; print(sounddevice.query_devices())"` for available mics
- Make sure the mic isn't claimed by another process
- Try running with `--debug` to see device selection

### Wake word not detecting
- Run `python listener.py --record-templates` to record reference audio
- Try lower sensitivity: `--sensitivity 5`
- Check if the ONNX model exists: `ls clive-listener/models/hey_clive.onnx`
- If missing, retrain: `npm run train:wakeword`
