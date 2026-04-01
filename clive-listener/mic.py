"""
mic.py — Microphone capture with resampling.

Adapted from TARS-AI's module_mic.py (authored by Charles-Olivier Dion).
Simplified for Clive's single-consumer use case.

Captures audio from the system default input device at its native sample rate,
resamples to 16kHz model rate, and provides a simple read interface.
"""

import threading
import collections
import numpy as np
import sounddevice as sd

try:
    import soxr as _soxr
    _HAS_SOXR = True
except ImportError:
    from scipy.signal import resample_poly as _resample_poly
    _HAS_SOXR = False

MODEL_RATE = 16000

# ── Device detection ──────────────────────────────────────────────

_device_info = None
_device_lock = threading.Lock()


def _find_input_device():
    """Find a working input device. Returns (idx, native_rate)."""
    # Try system default
    idx = sd.default.device[0]
    if idx is not None and idx >= 0:
        info = sd.query_devices(idx, kind="input")
        if info.get("max_input_channels", 0) >= 1:
            return idx, int(info.get("default_samplerate", MODEL_RATE))

    # Scan all devices
    devices = sd.query_devices()
    for i, dev in enumerate(devices):
        if dev.get("max_input_channels", 0) >= 1:
            rate = int(dev.get("default_samplerate", MODEL_RATE))
            return i, rate

    raise RuntimeError("No input audio device found")


def get_device_info():
    """Return (device_idx, native_sample_rate), cached after first call."""
    global _device_info
    if _device_info is not None:
        return _device_info
    with _device_lock:
        if _device_info is not None:
            return _device_info
        _device_info = _find_input_device()
    return _device_info


# ── Resampling ────────────────────────────────────────────────────

def resample(data, orig_sr, target_sr):
    """Resample audio. Preserves dtype: int16 in -> int16 out."""
    if orig_sr == target_sr:
        return data
    was_int = data.dtype == np.int16
    f = data.astype(np.float32) if was_int else np.asarray(data, dtype=np.float32)
    if _HAS_SOXR:
        from math import gcd as _gcd
        out = _soxr.resample(f, orig_sr, target_sr)
    else:
        from math import gcd as _gcd
        g = _gcd(target_sr, orig_sr)
        out = _resample_poly(f, target_sr // g, orig_sr // g, axis=0)
    if was_int:
        return np.clip(out, -32768, 32767).astype(np.int16)
    return out.astype(np.float32)


def dev_frames(model_frames, native_rate=None):
    """Convert frame count from MODEL_RATE to native device rate."""
    if native_rate is None:
        native_rate = get_device_info()[1]
    if native_rate == MODEL_RATE:
        return model_frames
    return int(model_frames * native_rate / MODEL_RATE)


# ── Microphone Stream ────────────────────────────────────────────

class MicStream:
    """Simple microphone stream that resamples to 16kHz.

    Usage:
        with MicStream() as mic:
            data = mic.read(4000)  # 4000 frames @ 16kHz = 250ms
            mic.flush()
    """

    def __init__(self):
        self._stream = None
        self._buf = collections.deque(maxlen=500)
        self._evt = threading.Event()
        self._native_rate = None

    def _on_audio(self, indata, frames, time_info, status):
        """PortAudio callback — runs in real-time thread."""
        self._buf.append(indata.copy())
        self._evt.set()

    def start(self):
        idx, rate = get_device_info()
        self._native_rate = rate
        kwargs = dict(samplerate=rate, channels=1, callback=self._on_audio)
        if idx is not None and idx >= 0:
            kwargs["device"] = idx
        self._stream = sd.InputStream(**kwargs)
        self._stream.start()
        return self

    def stop(self):
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

    def read(self, model_frames):
        """Read model_frames of audio at 16kHz. Blocks until available.
        Returns float32 numpy array of shape (model_frames,).
        """
        n_native = dev_frames(model_frames, self._native_rate)
        collected = []
        remaining = n_native

        while remaining > 0:
            while self._buf and remaining > 0:
                chunk = self._buf.popleft()
                flat = chunk.ravel()
                if len(flat) <= remaining:
                    collected.append(flat)
                    remaining -= len(flat)
                else:
                    collected.append(flat[:remaining])
                    leftover = flat[remaining:]
                    self._buf.appendleft(leftover.reshape(-1, 1))
                    remaining = 0

            if remaining > 0:
                self._evt.clear()
                if self._buf:
                    continue
                if not self._evt.wait(timeout=5.0):
                    # Timeout — return silence
                    if collected:
                        audio = np.concatenate(collected)
                    else:
                        audio = np.zeros(n_native, dtype=np.float32)
                    break

        if remaining <= 0:
            audio = np.concatenate(collected)[:n_native]

        # Resample to model rate
        if self._native_rate != MODEL_RATE:
            audio = resample(audio, self._native_rate, MODEL_RATE)

        # Ensure exact size
        if len(audio) > model_frames:
            audio = audio[:model_frames]
        elif len(audio) < model_frames:
            audio = np.pad(audio, (0, model_frames - len(audio)))

        return audio.astype(np.float32)

    def flush(self, n_reads=4, frames_per_read=2000):
        """Discard stale audio from buffer."""
        self._buf.clear()
        for _ in range(n_reads):
            self._evt.clear()
            if self._buf:
                self._buf.popleft()
            else:
                self._evt.wait(timeout=0.1)
        self._buf.clear()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False
