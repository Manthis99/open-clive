#!/usr/bin/env python3
"""
Clive Listener — Always-on wake word + voice capture sidecar.

Connects to Clive's host server via WebSocket as a headless audio client.
Captures microphone audio, detects wake word, records speech with VAD,
and sends audio to the server for STT processing.

State machine:
  STANDBY  → always listening for wake word
  LISTENING → wake word detected, recording with VAD
  WAITING  → audio sent, waiting for server response
  SPEAKING → server is speaking (TTS playback), muted

Usage:
  python listener.py [--host ws://localhost:3100] [--wake-word "hey clive"]
                     [--sensitivity 7] [--vad rms] [--debug]

  python listener.py --record-templates   # Record wake word templates
"""

import os
import sys
import json
import time
import struct
import signal
import asyncio
import argparse
import threading
import numpy as np

# Add parent for imports
sys.path.insert(0, os.path.dirname(__file__))

from mic import MicStream, MODEL_RATE
from wake_word import WakeWordDetector
from vad import create_vad

try:
    import websockets
except ImportError:
    print("Missing dependency: pip install websockets")
    sys.exit(1)


# ── State Machine ─────────────────────────────────────────────────

class ListenerState:
    STANDBY = "standby"
    LISTENING = "listening"
    WAITING = "waiting"
    SPEAKING = "speaking"


# ── Clive Listener ────────────────────────────────────────────────

class CliveListener:
    """Always-on voice listener for Clive.

    Captures mic → wake word detection → VAD recording → WebSocket send.
    """

    # Audio chunk size: 4000 frames @ 16kHz = 250ms
    CHUNK_FRAMES = 4000
    # Pre-roll: save last N chunks before speech for context
    PRE_ROLL_CHUNKS = 4  # ~1 second

    def __init__(self, host_url="ws://localhost:3100",
                 wake_word="hey clive", sensitivity=7,
                 vad_method="rms", debug=False):
        self.host_url = host_url
        self.debug = debug

        # Components
        self.mic = MicStream()
        self.detector = WakeWordDetector(
            wake_word=wake_word,
            sensitivity=sensitivity,
            debug=debug,
        )
        self.vad = create_vad(method=vad_method)

        # State
        self.state = ListenerState.STANDBY
        self.running = False
        self.ws = None
        self._pre_roll = []  # Recent chunks for context

    async def start(self):
        """Main entry point. Connect to server and start listening."""
        self.running = True

        # Load wake word model/templates
        if not self.detector.load():
            print("\n[Listener] No wake word model available.")
            print("[Listener] Run with --record-templates to create one.")
            print("[Listener] Or place hey_clive.onnx in clive-listener/models/")
            return

        # Start microphone
        self.mic.start()
        print(f"[Listener] Microphone started (rate={MODEL_RATE}Hz)")

        # Connect to server and run
        while self.running:
            try:
                print(f"[Listener] Connecting to {self.host_url}...")
                async with websockets.connect(self.host_url) as ws:
                    self.ws = ws
                    print(f"[Listener] Connected to Clive host")
                    self._set_state(ListenerState.STANDBY)

                    # Run both tasks: listen for server messages + process audio
                    await asyncio.gather(
                        self._receive_loop(ws),
                        self._audio_loop(ws),
                    )
            except websockets.ConnectionClosed:
                print("[Listener] Server disconnected, reconnecting in 3s...")
                self.ws = None
                await asyncio.sleep(3)
            except ConnectionRefusedError:
                print("[Listener] Server not available, retrying in 5s...")
                self.ws = None
                await asyncio.sleep(5)
            except Exception as e:
                print(f"[Listener] Error: {e}, retrying in 5s...")
                self.ws = None
                await asyncio.sleep(5)

        self.mic.stop()

    async def _receive_loop(self, ws):
        """Handle messages from the server."""
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    # Binary audio from TTS — we just track the state
                    continue
                try:
                    msg = json.loads(message)
                    await self._handle_server_message(msg)
                except json.JSONDecodeError:
                    pass
        except websockets.ConnectionClosed:
            raise

    async def _handle_server_message(self, msg):
        """Process server state changes and responses."""
        msg_type = msg.get("type", "")

        if msg_type == "state_change":
            server_state = msg.get("payload", {}).get("state", "")

            if server_state == "speaking":
                self._set_state(ListenerState.SPEAKING)
            elif server_state == "thinking" or server_state == "working":
                self._set_state(ListenerState.WAITING)
            elif server_state == "idle":
                if self.state in (ListenerState.WAITING, ListenerState.SPEAKING):
                    # Server done — flush mic buffer and go back to standby
                    self.mic.flush()
                    self._set_state(ListenerState.STANDBY)

        elif msg_type == "response_text":
            text = msg.get("payload", {}).get("text", "")
            if text and self.debug:
                print(f"\n[Clive] {text[:80]}{'...' if len(text) > 80 else ''}")

        elif msg_type == "transcript":
            text = msg.get("payload", {}).get("text", "")
            if text:
                print(f"[You] {text}")

        elif msg_type == "response_audio_end":
            # TTS playback done on server — go back to standby
            self.mic.flush()
            self._set_state(ListenerState.STANDBY)

    async def _audio_loop(self, ws):
        """Main audio processing loop."""
        while self.running:
            try:
                if self.state == ListenerState.STANDBY:
                    await self._do_standby(ws)
                elif self.state == ListenerState.LISTENING:
                    await self._do_listening(ws)
                else:
                    # WAITING or SPEAKING — just sleep
                    await asyncio.sleep(0.1)
            except websockets.ConnectionClosed:
                raise
            except Exception as e:
                print(f"[Listener] Audio loop error: {e}")
                self._set_state(ListenerState.STANDBY)
                await asyncio.sleep(0.5)

    async def _do_standby(self, ws):
        """Standby: listen for wake word."""
        # Read a small chunk for wake word detection
        chunk = await asyncio.get_event_loop().run_in_executor(
            None, self.mic.read, self.CHUNK_FRAMES
        )

        # Feed to wake word detector
        self.detector.feed(chunk)
        detected, score = self.detector.check()

        # Maintain pre-roll buffer
        self._pre_roll.append(chunk)
        if len(self._pre_roll) > self.PRE_ROLL_CHUNKS:
            self._pre_roll.pop(0)

        if detected:
            print(f"\n[Listener] Wake word detected! (score={score:.3f})")
            # Notify server
            await self._send_json(ws, {
                "type": "wake_word_detected",
                "payload": {},
                "timestamp": int(time.time() * 1000),
            })
            # Transition to listening
            self._set_state(ListenerState.LISTENING)

    async def _do_listening(self, ws):
        """Listening: record with VAD and send audio to server."""
        print("[Listener] Recording... (speak now)")

        # Tell server we're starting
        await self._send_json(ws, {
            "type": "press_to_talk_start",
            "payload": {},
            "timestamp": int(time.time() * 1000),
        })

        # Reset VAD
        self.vad.reset()

        # Send pre-roll audio (the audio from just before wake word)
        for pre_chunk in self._pre_roll:
            await self._send_audio(ws, pre_chunk)
        self._pre_roll.clear()

        # Record with VAD
        recording = True
        while recording and self.running and self.state == ListenerState.LISTENING:
            chunk = await asyncio.get_event_loop().run_in_executor(
                None, self.mic.read, self.CHUNK_FRAMES
            )

            # Send audio to server
            await self._send_audio(ws, chunk)

            # Check VAD
            status = self.vad.process(chunk)

            if status == 'silence':
                print("[Listener] End of speech detected")
                recording = False
            elif status == 'timeout':
                print("[Listener] No speech detected, returning to standby")
                # Cancel the recording
                await self._send_json(ws, {
                    "type": "cancel",
                    "payload": {},
                    "timestamp": int(time.time() * 1000),
                })
                self._set_state(ListenerState.STANDBY)
                return
            elif status == 'max_time':
                print("[Listener] Max recording time reached")
                recording = False

        # Tell server we're done recording
        await self._send_json(ws, {
            "type": "press_to_talk_end",
            "payload": {},
            "timestamp": int(time.time() * 1000),
        })

        self._set_state(ListenerState.WAITING)

    async def _send_audio(self, ws, audio_chunk):
        """Send audio as binary Int16 over WebSocket (matches browser format)."""
        int16 = np.clip(audio_chunk * 32768, -32768, 32767).astype(np.int16)
        await ws.send(int16.tobytes())

    async def _send_json(self, ws, msg):
        """Send a JSON message to the server."""
        await ws.send(json.dumps(msg))

    def _set_state(self, new_state):
        if new_state != self.state:
            old = self.state
            self.state = new_state
            if self.debug:
                print(f"[State] {old} → {new_state}")

    def stop(self):
        """Graceful shutdown."""
        self.running = False
        self.mic.stop()


# ── Template Recording Mode ───────────────────────────────────────

def record_templates(wake_word, models_dir=None):
    """Interactive template recording for wake word."""
    mic = MicStream()
    mic.start()

    detector = WakeWordDetector(wake_word=wake_word, models_dir=models_dir)
    success = detector.record_templates(mic)

    mic.stop()
    if success:
        print(f"\nTemplates saved! Start the listener with:")
        print(f"  python listener.py --wake-word \"{wake_word}\"")
    else:
        print("\nTemplate recording failed. Please try again.")


# ── Entry Point ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Clive Listener — wake word + voice capture")
    parser.add_argument("--host", default="ws://localhost:3100",
                        help="Clive host WebSocket URL")
    parser.add_argument("--wake-word", default="hey clive",
                        help="Wake word phrase (default: 'hey clive')")
    parser.add_argument("--sensitivity", type=int, default=7,
                        help="Wake word sensitivity 1-10 (default: 7)")
    parser.add_argument("--vad", choices=["rms", "sherpa"], default="rms",
                        help="VAD method (default: rms)")
    parser.add_argument("--debug", action="store_true",
                        help="Show detection scores and state changes")
    parser.add_argument("--record-templates", action="store_true",
                        help="Record wake word templates interactively")
    parser.add_argument("--models-dir", default=None,
                        help="Directory for wake word models")
    args = parser.parse_args()

    print("=" * 50)
    print("  Clive Listener")
    print(f"  Wake word: \"{args.wake_word}\"")
    print(f"  Host: {args.host}")
    print(f"  VAD: {args.vad}")
    print(f"  Sensitivity: {args.sensitivity}/10")
    print("=" * 50)

    if args.record_templates:
        record_templates(args.wake_word, args.models_dir)
        return

    listener = CliveListener(
        host_url=args.host,
        wake_word=args.wake_word,
        sensitivity=args.sensitivity,
        vad_method=args.vad,
        debug=args.debug,
    )

    # Handle Ctrl+C
    def signal_handler(sig, frame):
        print("\n[Listener] Shutting down...")
        listener.stop()
    signal.signal(signal.SIGINT, signal_handler)

    try:
        asyncio.run(listener.start())
    except KeyboardInterrupt:
        listener.stop()


if __name__ == "__main__":
    main()
