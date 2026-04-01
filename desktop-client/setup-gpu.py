#!/usr/bin/env python3
"""
Clive Desktop GPU Environment Setup

Run this script on your Windows PC with the 2080 TI to:
1. Create a Python virtual environment
2. Install CUDA-enabled PyTorch
3. Install faster-whisper for STT
4. Install CSM dependencies for TTS
5. Verify GPU is accessible

Usage:
    python setup-gpu.py

Requirements:
    - Python 3.10+ (3.10 recommended for CSM compatibility)
    - NVIDIA GPU with CUDA 12.x drivers installed
    - ~10GB disk space for models (downloaded on first run)
"""

import subprocess
import sys
import os
import platform

VENV_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.venv')
IS_WINDOWS = platform.system() == 'Windows'
PYTHON_BIN = os.path.join(VENV_DIR, 'Scripts' if IS_WINDOWS else 'bin', 'python' + ('.exe' if IS_WINDOWS else '3'))
PIP_BIN = os.path.join(VENV_DIR, 'Scripts' if IS_WINDOWS else 'bin', 'pip' + ('.exe' if IS_WINDOWS else '3'))


def run(cmd, check=True, **kwargs):
    """Run a command and print it."""
    print(f"\n{'='*60}")
    print(f"  Running: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    print(f"{'='*60}\n")
    return subprocess.run(cmd, check=check, **kwargs)


def main():
    print("=" * 60)
    print("  Clive Desktop — GPU Setup")
    print(f"  Platform: {platform.system()} {platform.machine()}")
    print(f"  Python: {sys.version}")
    print("=" * 60)

    # Step 1: Create virtual environment
    if not os.path.exists(VENV_DIR):
        print("\n[1/5] Creating virtual environment...")
        run([sys.executable, '-m', 'venv', VENV_DIR])
    else:
        print(f"\n[1/5] Virtual environment exists at {VENV_DIR}")

    # Step 2: Upgrade pip
    print("\n[2/5] Upgrading pip...")
    run([PYTHON_BIN, '-m', 'pip', 'install', '--upgrade', 'pip'])

    # Step 3: Install PyTorch with CUDA
    print("\n[3/5] Installing PyTorch with CUDA support...")
    torch_cmd = [
        PIP_BIN, 'install',
        'torch==2.4.0', 'torchaudio==2.4.0',
        '--index-url', 'https://download.pytorch.org/whl/cu124',
    ]
    if IS_WINDOWS:
        # Windows needs triton-windows instead of triton
        run([PIP_BIN, 'install', 'triton-windows'])
    run(torch_cmd)

    # Step 4: Install faster-whisper for STT
    print("\n[4/5] Installing faster-whisper (STT)...")
    run([PIP_BIN, 'install', 'faster-whisper'])

    # Step 5: Install CSM dependencies for TTS
    print("\n[5/5] Installing CSM dependencies (TTS)...")
    csm_deps = [
        'transformers>=4.52.1',
        'tokenizers>=0.21.0',
        'torchtune==0.4.0',
        'torchao==0.9.0',
        'moshi==0.2.2',
    ]
    run([PIP_BIN, 'install'] + csm_deps)

    # Install silentcipher from CSM repo
    csm_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'external', 'csm')
    if os.path.exists(os.path.join(csm_dir, 'requirements.txt')):
        print("\n[Bonus] Installing CSM repo requirements...")
        run([PIP_BIN, 'install', '-r', os.path.join(csm_dir, 'requirements.txt')], check=False)

    # Verify GPU
    print("\n" + "=" * 60)
    print("  Verification")
    print("=" * 60)

    result = subprocess.run(
        [PYTHON_BIN, '-c', '''
import torch
print(f"  PyTorch version: {torch.__version__}")
print(f"  CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"  CUDA version: {torch.version.cuda}")
    print(f"  GPU: {torch.cuda.get_device_name(0)}")
    print(f"  VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB")
else:
    print("  WARNING: CUDA not available! Check your NVIDIA drivers.")

try:
    from faster_whisper import WhisperModel
    print(f"  faster-whisper: OK")
except ImportError as e:
    print(f"  faster-whisper: MISSING ({e})")

try:
    import transformers
    print(f"  transformers: {transformers.__version__}")
except ImportError as e:
    print(f"  transformers: MISSING ({e})")
'''],
        capture_output=True,
        text=True,
    )

    print(result.stdout)
    if result.stderr:
        print(result.stderr)

    print("\n" + "=" * 60)
    if "CUDA available: True" in result.stdout:
        print("  Setup complete! GPU is ready.")
        print(f"  To start Clive Desktop:")
        print(f"    cd desktop-client")
        print(f"    npm install")
        print(f"    npm run dev:gpu")
    else:
        print("  Setup complete but CUDA was not detected.")
        print("  Make sure NVIDIA drivers + CUDA toolkit are installed.")
        print("  You can still run in mock mode: npm run dev")
    print("=" * 60)


if __name__ == '__main__':
    main()
