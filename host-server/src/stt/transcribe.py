#!/usr/bin/env python3
"""
Transcribe audio using faster-whisper.
Called as a subprocess from Node.js.

Usage: python3 transcribe.py <audio_file_path>
Outputs: transcript text to stdout

Install: pip install faster-whisper
"""

import sys
import os

def transcribe(audio_path):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("Error: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)

    model_size = os.environ.get("WHISPER_MODEL", "base")

    # Use CPU on Mac M1 (or cuda if available)
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = "int8" if device == "cpu" else "float16"

    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    segments, info = model.transcribe(audio_path, beam_size=5, language="en")

    transcript = " ".join(segment.text for segment in segments)
    print(transcript.strip())


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 transcribe.py <audio_file>", file=sys.stderr)
        sys.exit(1)

    transcribe(sys.argv[1])
