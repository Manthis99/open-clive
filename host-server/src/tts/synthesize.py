#!/usr/bin/env python3
"""
Text-to-Speech using Piper CLI.
Called as a subprocess from Node.js.

Usage: python3 synthesize.py "Text to speak" <output_wav_path>
"""

import sys
import os
import subprocess

def synthesize(text, output_path):
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../models')
    model_path = os.path.join(model_dir, 'en_US-lessac-medium.onnx')

    if not os.path.exists(model_path):
        print(f"Error: Model not found at {model_path}", file=sys.stderr)
        sys.exit(1)

    venv_bin = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../.venv/bin')
    piper_bin = os.path.join(venv_bin, 'piper')

    result = subprocess.run(
        [piper_bin, '-m', model_path, '-f', output_path],
        input=text,
        capture_output=True,
        text=True,
        timeout=15,
    )

    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(1)

    print(output_path)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 synthesize.py <text> <output_wav>", file=sys.stderr)
        sys.exit(1)

    synthesize(sys.argv[1], sys.argv[2])
