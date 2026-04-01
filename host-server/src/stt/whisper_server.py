#!/usr/bin/env python3
"""
Persistent Whisper STT Server

Keeps the faster-whisper model loaded in GPU VRAM for instant transcription.
Communicates with Node.js via JSON over stdin/stdout.

Protocol:
  → stdin:  {"type": "transcribe", "audio_path": "/tmp/audio.wav"}
  ← stdout: {"type": "transcript", "text": "Hello world", "duration_ms": 234}
  ← stdout: {"type": "error", "message": "..."}
  → stdin:  {"type": "shutdown"}

Requirements:
  pip install faster-whisper
"""

import sys
import os
import json
import time
import traceback


def log(msg):
    """Log to stderr so it doesn't interfere with JSON stdout protocol."""
    print(f"[whisper_server] {msg}", file=sys.stderr, flush=True)


def get_vram_mb():
    """Get current GPU VRAM usage in MB."""
    try:
        import torch
        if torch.cuda.is_available():
            return round(torch.cuda.memory_allocated() / 1024 / 1024)
    except Exception:
        pass
    return 0


def send_json(obj):
    """Send a JSON message to stdout."""
    print(json.dumps(obj), flush=True)


class WhisperServer:
    def __init__(self):
        self.model_size = os.environ.get("WHISPER_MODEL", "small")
        self.device = os.environ.get("WHISPER_DEVICE", "cuda")
        self.compute_type = "int8" if self.device == "cpu" else "float16"
        self.language = os.environ.get("WHISPER_LANGUAGE", "en")
        self.beam_size = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
        self.model = None

    def load_model(self):
        """Load faster-whisper model into VRAM."""
        log(f"Loading faster-whisper model={self.model_size} device={self.device} compute={self.compute_type}")

        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise RuntimeError("faster-whisper not installed. Run: pip install faster-whisper")

        self.model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type,
        )

        log(f"Model loaded: {self.model_size} on {self.device}")

    def transcribe(self, audio_path):
        """Transcribe an audio file.

        Args:
            audio_path: Path to WAV file

        Returns:
            Transcript text
        """
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        segments, info = self.model.transcribe(
            audio_path,
            beam_size=self.beam_size,
            language=self.language,
        )

        transcript = " ".join(segment.text for segment in segments)
        return transcript.strip()

    def run(self):
        """Main event loop."""
        log("Starting Whisper server...")

        try:
            self.load_model()
        except Exception as e:
            send_json({"type": "error", "message": f"Failed to load model: {e}"})
            log(f"FATAL: {traceback.format_exc()}")
            sys.exit(1)

        vram = get_vram_mb()
        send_json({
            "type": "ready",
            "model": self.model_size,
            "device": self.device,
            "compute_type": self.compute_type,
            "vram_mb": vram,
        })

        log(f"Ready. Model: {self.model_size}, VRAM: {vram}MB. Waiting for requests...")

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                send_json({"type": "error", "message": f"Invalid JSON: {e}"})
                continue

            req_type = request.get("type")

            if req_type == "shutdown":
                log("Shutdown requested")
                break

            elif req_type == "transcribe":
                audio_path = request.get("audio_path")
                if not audio_path:
                    send_json({"type": "error", "message": "Missing audio_path"})
                    continue

                start_time = time.time()
                try:
                    text = self.transcribe(audio_path)
                    duration_ms = round((time.time() - start_time) * 1000)

                    send_json({
                        "type": "transcript",
                        "text": text,
                        "duration_ms": duration_ms,
                    })

                    log(f"Transcribed in {duration_ms}ms: \"{text[:60]}{'...' if len(text) > 60 else ''}\"")

                except Exception as e:
                    log(f"Transcription error: {traceback.format_exc()}")
                    send_json({"type": "error", "message": str(e)})

            elif req_type == "ping":
                send_json({"type": "pong", "vram_mb": get_vram_mb()})

            else:
                send_json({"type": "error", "message": f"Unknown request type: {req_type}"})

        log("Server stopped")


if __name__ == "__main__":
    server = WhisperServer()
    server.run()
