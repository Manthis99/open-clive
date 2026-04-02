#!/usr/bin/env python3
"""
Clive Listener — Always-on wake word + voice capture sidecar.
"""

import argparse
import asyncio
import json
import os
import signal
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

from mic import MicStream, MODEL_RATE
from vad import create_vad
from wake_word import WakeWordDetector

try:
    import websockets
except ImportError:
    print("Missing dependency: pip install -r requirements.txt")
    sys.exit(1)


class ListenerState:
    STANDBY = "standby"
    LISTENING = "listening"
    WAITING = "waiting"
    SPEAKING = "speaking"


class CliveListener:
    CHUNK_FRAMES = 4000
    PRE_ROLL_CHUNKS = 4

    def __init__(self, host_url="ws://localhost:3100",
                 wake_word="hey clive", sensitivity=7,
                 vad_method="rms", debug=False):
        self.host_url = host_url
        self.debug = debug
        self.mic = MicStream()
        self.detector = WakeWordDetector(
            wake_word=wake_word,
            sensitivity=sensitivity,
            debug=debug,
        )
        self.vad = create_vad(method=vad_method)
        self.state = ListenerState.STANDBY
        self.running = False
        self.ws = None
        self._pre_roll = []
        self._awaiting_wake_chime = False

    async def start(self):
        self.running = True

        if not self.detector.load():
            print("\n[Listener] No wake word model available.")
            print("[Listener] Run with --record-templates to create one.")
            print("[Listener] Or place hey_clive.onnx in clive-listener/models/")
            return

        self.mic.start()
        print(f"[Listener] Microphone started (rate={MODEL_RATE}Hz)")

        while self.running:
            try:
                print(f"[Listener] Connecting to {self.host_url}...")
                async with websockets.connect(self.host_url) as ws:
                    self.ws = ws
                    await self._send_json(ws, {
                        "type": "client_hello",
                        "payload": {
                            "role": "listener",
                            "canReceiveAudio": False,
                        },
                        "timestamp": int(time.time() * 1000),
                    })
                    print("[Listener] Connected to Clive host")
                    self._set_state(ListenerState.STANDBY)

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
            except Exception as exc:
                print(f"[Listener] Error: {exc}, retrying in 5s...")
                self.ws = None
                await asyncio.sleep(5)

        self.mic.stop()

    async def _receive_loop(self, ws):
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    continue
                try:
                    await self._handle_server_message(json.loads(message))
                except json.JSONDecodeError:
                    pass
        except websockets.ConnectionClosed:
            raise

    async def _handle_server_message(self, msg):
        msg_type = msg.get("type", "")

        if msg_type == "state_change":
            server_state = msg.get("payload", {}).get("state", "")
            if server_state == "speaking":
                self._set_state(ListenerState.SPEAKING)
            elif server_state in ("thinking", "working"):
                self._set_state(ListenerState.WAITING)
            elif server_state == "idle" and self.state in (ListenerState.WAITING, ListenerState.SPEAKING):
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
            self.mic.flush()
            if self._awaiting_wake_chime and self.state == ListenerState.LISTENING:
                self._awaiting_wake_chime = False
            elif self.state in (ListenerState.WAITING, ListenerState.SPEAKING):
                self._set_state(ListenerState.STANDBY)

    async def _audio_loop(self, ws):
        while self.running:
            try:
                if self.state == ListenerState.STANDBY:
                    await self._do_standby(ws)
                elif self.state == ListenerState.LISTENING:
                    if self._awaiting_wake_chime:
                        await asyncio.sleep(0.05)
                    else:
                        await self._do_listening(ws)
                else:
                    await asyncio.sleep(0.1)
            except websockets.ConnectionClosed:
                raise
            except Exception as exc:
                print(f"[Listener] Audio loop error: {exc}")
                self._set_state(ListenerState.STANDBY)
                await asyncio.sleep(0.5)

    async def _do_standby(self, ws):
        chunk = await asyncio.get_event_loop().run_in_executor(
            None, self.mic.read, self.CHUNK_FRAMES
        )

        self.detector.feed(chunk)
        detected, score = self.detector.check()

        self._pre_roll.append(chunk)
        if len(self._pre_roll) > self.PRE_ROLL_CHUNKS:
            self._pre_roll.pop(0)

        if detected:
            print(f"\n[Listener] Wake word detected! (score={score:.3f})")
            await self._send_json(ws, {
                "type": "wake_word_detected",
                "payload": {},
                "timestamp": int(time.time() * 1000),
            })
            self._awaiting_wake_chime = True
            self._set_state(ListenerState.LISTENING)

    async def _do_listening(self, ws):
        print("[Listener] Recording... (speak now)")

        await self._send_json(ws, {
            "type": "press_to_talk_start",
            "payload": {},
            "timestamp": int(time.time() * 1000),
        })

        self.vad.reset()

        for pre_chunk in self._pre_roll:
            await self._send_audio(ws, pre_chunk)
        self._pre_roll.clear()

        recording = True
        while recording and self.running and self.state == ListenerState.LISTENING:
            chunk = await asyncio.get_event_loop().run_in_executor(
                None, self.mic.read, self.CHUNK_FRAMES
            )
            await self._send_audio(ws, chunk)
            status = self.vad.process(chunk)

            if status == "silence":
                print("[Listener] End of speech detected")
                recording = False
            elif status == "timeout":
                print("[Listener] No speech detected, returning to standby")
                await self._send_json(ws, {
                    "type": "cancel",
                    "payload": {},
                    "timestamp": int(time.time() * 1000),
                })
                self._awaiting_wake_chime = False
                self._set_state(ListenerState.STANDBY)
                return
            elif status == "max_time":
                print("[Listener] Max recording time reached")
                recording = False

        await self._send_json(ws, {
            "type": "press_to_talk_end",
            "payload": {},
            "timestamp": int(time.time() * 1000),
        })
        self._awaiting_wake_chime = False
        self._set_state(ListenerState.WAITING)

    async def _send_audio(self, ws, audio_chunk):
        int16 = np.clip(audio_chunk * 32768, -32768, 32767).astype(np.int16)
        await ws.send(int16.tobytes())

    async def _send_json(self, ws, msg):
        await ws.send(json.dumps(msg))

    def _set_state(self, new_state):
        if new_state != self.state:
            old = self.state
            self.state = new_state
            if self.debug:
                print(f"[State] {old} -> {new_state}")

    def stop(self):
        self.running = False
        self.mic.stop()


def record_templates(wake_word, models_dir=None):
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


def main():
    parser = argparse.ArgumentParser(description="Clive Listener — wake word + voice capture")
    parser.add_argument("--host", default=os.environ.get("CLIVE_LISTENER_HOST", "ws://localhost:3100"),
                        help="Clive host WebSocket URL")
    parser.add_argument("--wake-word", default=os.environ.get("CLIVE_WAKE_WORD", "hey clive"),
                        help="Wake word phrase")
    parser.add_argument("--sensitivity", type=int, default=int(os.environ.get("CLIVE_WAKE_SENSITIVITY", "7")),
                        help="Wake word sensitivity 1-10")
    parser.add_argument("--vad", choices=["rms", "sherpa"], default=os.environ.get("CLIVE_LISTENER_VAD", "rms"),
                        help="VAD method")
    parser.add_argument("--debug", action="store_true", help="Show detection scores and state changes")
    parser.add_argument("--record-templates", action="store_true", help="Record wake word templates interactively")
    parser.add_argument("--models-dir", default=os.environ.get("CLIVE_LISTENER_MODELS_DIR"),
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
