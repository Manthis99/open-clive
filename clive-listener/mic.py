"""
mic.py — Microphone capture with resampling.

Adapted from TARS-AI's module_mic.py (authored by Charles-Olivier Dion).
Simplified for Clive's single-consumer use case.
"""

import collections
import threading

import numpy as np
import sounddevice as sd

try:
    import soxr as _soxr
    _HAS_SOXR = True
except ImportError:
    from scipy.signal import resample_poly as _resample_poly
    _HAS_SOXR = False

MODEL_RATE = 16000

_device_info = None
_device_lock = threading.Lock()


def _find_input_device():
    idx = sd.default.device[0]
    if idx is not None and idx >= 0:
        info = sd.query_devices(idx, kind="input")
        if info.get("max_input_channels", 0) >= 1:
            return idx, int(info.get("default_samplerate", MODEL_RATE))

    for i, dev in enumerate(sd.query_devices()):
        if dev.get("max_input_channels", 0) >= 1:
            return i, int(dev.get("default_samplerate", MODEL_RATE))

    raise RuntimeError("No input audio device found")


def get_device_info():
    global _device_info
    if _device_info is not None:
        return _device_info
    with _device_lock:
        if _device_info is None:
            _device_info = _find_input_device()
    return _device_info


def resample(data, orig_sr, target_sr):
    if orig_sr == target_sr:
        return data
    was_int = data.dtype == np.int16
    audio = data.astype(np.float32) if was_int else np.asarray(data, dtype=np.float32)
    if _HAS_SOXR:
        out = _soxr.resample(audio, orig_sr, target_sr)
    else:
        from math import gcd
        factor = gcd(target_sr, orig_sr)
        out = _resample_poly(audio, target_sr // factor, orig_sr // factor, axis=0)
    if was_int:
        return np.clip(out, -32768, 32767).astype(np.int16)
    return out.astype(np.float32)


def dev_frames(model_frames, native_rate=None):
    native_rate = native_rate or get_device_info()[1]
    if native_rate == MODEL_RATE:
        return model_frames
    return int(model_frames * native_rate / MODEL_RATE)


class MicStream:
    """Simple microphone stream that resamples to 16kHz."""

    def __init__(self):
        self._stream = None
        self._buf = collections.deque(maxlen=500)
        self._evt = threading.Event()
        self._native_rate = None

    def _on_audio(self, indata, frames, time_info, status):
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
        if not self._stream:
            return
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass
        self._stream = None

    def read(self, model_frames):
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
                    audio = np.concatenate(collected) if collected else np.zeros(n_native, dtype=np.float32)
                    break

        if remaining <= 0:
            audio = np.concatenate(collected)[:n_native]

        if self._native_rate != MODEL_RATE:
            audio = resample(audio, self._native_rate, MODEL_RATE)

        if len(audio) > model_frames:
            audio = audio[:model_frames]
        elif len(audio) < model_frames:
            audio = np.pad(audio, (0, model_frames - len(audio)))

        return audio.astype(np.float32)

    def flush(self, n_reads=4):
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
