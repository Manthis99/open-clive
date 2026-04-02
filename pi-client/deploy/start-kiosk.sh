#!/usr/bin/env bash
set -euo pipefail

CHROMIUM_BIN="${CHROMIUM_BIN:-/usr/bin/chromium-browser}"
CLIVE_UI_URL="${CLIVE_UI_URL:-http://localhost:3000}"
DISPLAY="${DISPLAY:-:0}"
XAUTHORITY="${XAUTHORITY:-/home/pi/.Xauthority}"

export DISPLAY
export XAUTHORITY

until curl -fsS "${CLIVE_UI_URL}" >/dev/null 2>&1; do
  sleep 2
done

mkdir -p "${HOME}/.config/chromium"
pkill -f "chromium.*${CLIVE_UI_URL}" >/dev/null 2>&1 || true
sleep 1

exec "${CHROMIUM_BIN}" \
  --kiosk \
  --app="${CLIVE_UI_URL}" \
  --incognito \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required
