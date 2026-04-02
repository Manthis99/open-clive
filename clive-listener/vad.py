"""
vad.py — Voice Activity Detection for Clive.
"""

import time

import numpy as np


class RmsVAD:
    def __init__(self, sample_rate=16000, silence_duration=1.5,
                 silence_margin=3.0, pre_speech_timeout=5.0):
        self.sample_rate = sample_rate
        self.silence_duration = silence_duration
        self.silence_margin = silence_margin
        self.pre_speech_timeout = pre_speech_timeout
        self._noise_floor = 0.005
        self._noise_alpha = 0.05
        self._speech_started = False
        self._silence_start = None
        self._recording_start = None
        self._max_recording = 30.0

    def reset(self):
        self._speech_started = False
        self._silence_start = None
        self._recording_start = time.time()

    @property
    def speech_threshold(self):
        return self._noise_floor * self.silence_margin

    def process(self, audio_chunk):
        rms = np.sqrt(np.mean(audio_chunk.astype(np.float32) ** 2))
        now = time.time()

        if self._recording_start and now - self._recording_start > self._max_recording:
            return "max_time"

        is_speech = rms > self.speech_threshold

        if not self._speech_started:
            if is_speech:
                self._speech_started = True
                self._silence_start = None
                return "speech"

            self._noise_floor = (
                (1 - self._noise_alpha) * self._noise_floor +
                self._noise_alpha * rms
            )
            if self._recording_start and now - self._recording_start > self.pre_speech_timeout:
                return "timeout"
            return "waiting"

        if is_speech:
            self._silence_start = None
            return "speech"

        if self._silence_start is None:
            self._silence_start = now
        if now - self._silence_start >= self.silence_duration:
            return "silence"
        return "speech"


class SherpaVAD:
    def __init__(self, sample_rate=16000, silence_duration=1.5,
                 pre_speech_timeout=5.0):
        self.sample_rate = sample_rate
        self.silence_duration = silence_duration
        self.pre_speech_timeout = pre_speech_timeout
        self._vad = None
        self._speech_started = False
        self._silence_start = None
        self._recording_start = None
        self._max_recording = 30.0

    def load(self):
        try:
            import sherpa_onnx
            config = sherpa_onnx.VadModelConfig()
            config.silero_vad.model = ""
            config.silero_vad.threshold = 0.3
            config.silero_vad.min_speech_duration = 0.1
            config.silero_vad.min_silence_duration = self.silence_duration
            config.silero_vad.max_speech_duration = self._max_recording
            config.sample_rate = self.sample_rate
            self._vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)
            print("[VAD] Sherpa-ONNX Silero VAD loaded")
            return True
        except ImportError:
            print("[VAD] sherpa-onnx not installed, falling back to RMS VAD")
            return False
        except Exception as exc:
            print(f"[VAD] Sherpa-ONNX init failed: {exc}")
            return False

    def reset(self):
        self._speech_started = False
        self._silence_start = None
        self._recording_start = time.time()
        if self._vad:
            self._vad.reset()

    def process(self, audio_chunk):
        if not self._vad:
            return "waiting"

        now = time.time()
        if self._recording_start and now - self._recording_start > self._max_recording:
            return "max_time"

        self._vad.accept_waveform(audio_chunk.astype(np.float32).ravel())
        is_speech = self._vad.is_speech_detected()

        if not self._speech_started:
            if is_speech:
                self._speech_started = True
                self._silence_start = None
                return "speech"
            if self._recording_start and now - self._recording_start > self.pre_speech_timeout:
                return "timeout"
            return "waiting"

        if is_speech:
            self._silence_start = None
            return "speech"

        if self._silence_start is None:
            self._silence_start = now
        if now - self._silence_start >= self.silence_duration:
            return "silence"
        return "speech"


def create_vad(method="rms", **kwargs):
    if method == "sherpa":
        vad = SherpaVAD(**kwargs)
        if vad.load():
            return vad
        print("[VAD] Falling back to RMS VAD")
    return RmsVAD(**kwargs)
