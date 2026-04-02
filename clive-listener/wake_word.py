"""
wake_word.py — Wake word detection for Clive.

Inspired by TARS-AI's Atomik system (authored by Charles-Olivier Dion).
"""

import json
import os
import pickle
import time
from collections import deque

import numpy as np
from scipy.fftpack import dct


class MFCCExtractor:
    def __init__(self, sample_rate=16000, n_mfcc=13, n_fft=512):
        self.sample_rate = sample_rate
        self.n_mfcc = n_mfcc
        self.n_fft = n_fft
        self.n_mels = 40
        self.mel_filters = self._create_mel_filterbank()

    def _hz_to_mel(self, hz):
        return 2595 * np.log10(1 + hz / 700.0)

    def _mel_to_hz(self, mel):
        return 700 * (10 ** (mel / 2595.0) - 1)

    def _create_mel_filterbank(self):
        low_mel = 0
        high_mel = self._hz_to_mel(self.sample_rate / 2)
        mel_points = np.linspace(low_mel, high_mel, self.n_mels + 2)
        hz_points = self._mel_to_hz(mel_points)
        bin_points = np.floor((self.n_fft + 1) * hz_points / self.sample_rate).astype(int)

        fbank = np.zeros((self.n_mels, self.n_fft // 2 + 1))
        for m in range(1, self.n_mels + 1):
            f_left, f_center, f_right = bin_points[m - 1:m + 2]
            for k in range(f_left, f_center):
                fbank[m - 1, k] = (k - f_left) / (f_center - f_left)
            for k in range(f_center, f_right):
                fbank[m - 1, k] = (f_right - k) / (f_right - f_center)
        return fbank

    def extract(self, audio):
        if len(audio) < self.n_fft:
            return None

        emphasized = np.append(audio[0], audio[1:] - 0.97 * audio[:-1])
        frame_length = self.n_fft
        hop = frame_length // 2
        n_frames = 1 + int(np.floor((len(emphasized) - frame_length) / hop))
        frames = np.zeros((n_frames, frame_length))
        for i in range(n_frames):
            start = i * hop
            frames[i] = emphasized[start:start + frame_length]

        frames *= np.hamming(frame_length)
        mag = np.absolute(np.fft.rfft(frames, self.n_fft))
        power = (1.0 / self.n_fft) * (mag ** 2)

        fb = np.dot(power, self.mel_filters.T)
        fb = np.where(fb == 0, np.finfo(float).eps, fb)
        fb = 20 * np.log10(fb)
        mfcc = dct(fb, type=2, axis=1, norm="ortho")[:, :self.n_mfcc]

        return (mfcc - np.mean(mfcc, axis=0)) / (np.std(mfcc, axis=0) + 1e-8)

    def _compute_deltas(self, features, width=2):
        n_frames, n_feats = features.shape
        deltas = np.zeros_like(features)
        denom = 2 * sum(t ** 2 for t in range(1, width + 1))
        if denom == 0:
            return deltas
        for t in range(n_frames):
            num = np.zeros(n_feats)
            for tau in range(1, width + 1):
                t_plus = min(t + tau, n_frames - 1)
                t_minus = max(t - tau, 0)
                num += tau * (features[t_plus] - features[t_minus])
            deltas[t] = num / denom
        return deltas

    def extract_fixed(self, audio, target_frames=62, use_deltas=False):
        mfcc = self.extract(audio)
        if mfcc is None:
            return None

        if use_deltas:
            delta = self._compute_deltas(mfcc)
            delta2 = self._compute_deltas(delta)
            features = np.hstack([mfcc, delta, delta2])
        else:
            features = mfcc

        n = features.shape[0]
        if n >= target_frames:
            return features[:target_frames].astype(np.float32)
        pad = np.zeros((target_frames - n, features.shape[1]))
        return np.vstack([features, pad]).astype(np.float32)


class OnnxWakeWordModel:
    def __init__(self, onnx_path, meta_path=None):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 2
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            onnx_path, opts, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.meta = {}
        if meta_path and os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as handle:
                self.meta = json.load(handle)

    def predict(self, mfcc_2d):
        inp = mfcc_2d[np.newaxis, :, :].astype(np.float32)
        result = self.session.run([self.output_name], {self.input_name: inp})
        return float(result[0][0][0])


TARGET_FRAMES = 62


class WakeWordDetector:
    def __init__(self, wake_word="hey clive", sensitivity=7,
                 models_dir=None, mode="auto", debug=False):
        self.wake_word = wake_word
        self.sample_rate = 16000
        self.debug = debug
        self.mfcc = MFCCExtractor(sample_rate=self.sample_rate)
        self.buffer = deque(maxlen=self.sample_rate * 3)
        self.cooldown = 1.5
        self.last_detection_time = 0
        self.check_interval = 0.1
        self.last_check_time = 0
        self._recent_scores = deque(maxlen=5)
        self._confirmation_count = 2
        self._noise_floor = 0.005
        self._noise_alpha = 0.02
        self._min_snr = 3.0
        self._energy_threshold = 0.008
        self._model = None
        self._templates = []
        self._use_deltas = False
        self._mode = mode
        self._set_sensitivity(sensitivity)
        if models_dir is None:
            models_dir = os.path.join(os.path.dirname(__file__), "models")
        self._models_dir = models_dir

    def _set_sensitivity(self, sensitivity):
        sensitivity = max(1, min(10, sensitivity))
        self._model_threshold = 0.80 - (sensitivity - 1) * (0.40 / 9)
        self._template_threshold = 0.70 - (sensitivity - 1) * (0.30 / 9)

    @property
    def threshold(self):
        return self._model_threshold if self._model is not None else self._template_threshold

    def load(self):
        slug = self.wake_word.replace(" ", "_")
        os.makedirs(self._models_dir, exist_ok=True)

        if self._mode != "template":
            onnx_path = os.path.join(self._models_dir, f"{slug}.onnx")
            meta_path = os.path.join(self._models_dir, f"{slug}_meta.json")
            if os.path.exists(onnx_path):
                try:
                    self._model = OnnxWakeWordModel(onnx_path, meta_path)
                    if self._model.meta.get("n_features", 13) > 13:
                        self._use_deltas = True
                    print(f"[WakeWord] Loaded ONNX model: {onnx_path}")
                    print(f"[WakeWord] Threshold: {self.threshold:.2f}")
                    return True
                except Exception as exc:
                    print(f"[WakeWord] Failed to load ONNX model: {exc}")

        if self._mode != "model":
            templates_path = os.path.join(self._models_dir, f"{slug}_templates.pkl")
            if os.path.exists(templates_path):
                try:
                    with open(templates_path, "rb") as handle:
                        self._templates = pickle.load(handle)
                    print(f"[WakeWord] Loaded {len(self._templates)} templates")
                    print(f"[WakeWord] Threshold: {self.threshold:.2f}")
                    return True
                except Exception as exc:
                    print(f"[WakeWord] Failed to load templates: {exc}")

        print(f"[WakeWord] No model found for '{self.wake_word}'")
        print(f"[WakeWord] Place {slug}.onnx in {self._models_dir}/")
        print("[WakeWord] Or run template recording mode")
        return False

    def feed(self, audio_chunk):
        self.buffer.extend(audio_chunk.ravel())

    def check(self):
        if self._model is not None:
            return self._check_model()
        if self._templates:
            return self._check_template()
        return False, 0.0

    def _check_model(self):
        if len(self.buffer) < self.sample_rate:
            return False, 0.0

        now = time.time()
        if now - self.last_detection_time < self.cooldown:
            return False, 0.0
        if now - self.last_check_time < self.check_interval:
            return False, 0.0
        self.last_check_time = now

        audio = np.array(list(self.buffer)[-self.sample_rate:], dtype=np.float32)
        rms = np.sqrt(np.mean(audio ** 2))
        if rms < self._energy_threshold:
            self._noise_floor = (
                (1 - self._noise_alpha) * self._noise_floor + self._noise_alpha * rms
            )
            return False, 0.0

        snr = rms / (self._noise_floor + 1e-8)
        if snr < self._min_snr:
            return False, 0.0

        peak = np.max(np.abs(audio))
        crest = peak / (rms + 1e-8)
        if crest > 15:
            return False, 0.0

        fft_mag = np.abs(np.fft.rfft(audio))
        freqs = np.fft.rfftfreq(len(audio), 1.0 / self.sample_rate)
        speech_band = np.sum(fft_mag[(freqs >= 300) & (freqs <= 3000)])
        total_band = np.sum(fft_mag) + 1e-8
        if speech_band / total_band < 0.30:
            return False, 0.0

        low_band = np.sum(fft_mag[freqs < 300])
        if low_band / total_band > 0.60:
            return False, 0.0

        feat = self.mfcc.extract_fixed(audio, TARGET_FRAMES, self._use_deltas)
        if feat is None:
            return False, 0.0

        score = self._model.predict(feat)

        if self.threshold * 0.6 < score < self.threshold:
            for rate in [0.9, 1.1]:
                stretched = self._time_stretch(audio, rate)
                if len(stretched) < self.sample_rate:
                    stretched = np.pad(stretched, (0, self.sample_rate - len(stretched)))
                retry_feat = self.mfcc.extract_fixed(
                    stretched[:self.sample_rate], TARGET_FRAMES, self._use_deltas
                )
                if retry_feat is not None:
                    retry_score = self._model.predict(retry_feat)
                    if retry_score > score:
                        score = retry_score
                        if score >= self.threshold:
                            break

        self._recent_scores.append(score)
        above_count = sum(1 for s in self._recent_scores if s >= self.threshold)

        if self.debug and score > 0.1:
            filled = int(score * 30)
            bar = "#" * filled + "." * (30 - filled)
            print(
                f"\r  [wake] {bar} {score:.3f}/{self.threshold:.3f} "
                f"[{above_count}/{self._confirmation_count}]   ",
                end="",
                flush=True,
            )

        if above_count >= self._confirmation_count:
            if not self._is_speech_like(audio):
                self._recent_scores.clear()
                return False, score

            self.last_detection_time = time.time()
            self._recent_scores.clear()
            if self.debug:
                print(f"\r  [wake] >>> DETECTED ({score:.3f}) <<<" + " " * 30, flush=True)
            return True, score

        return False, score

    def _check_template(self):
        if not self._templates or len(self.buffer) < self.sample_rate:
            return False, 0.0

        now = time.time()
        if now - self.last_detection_time < self.cooldown:
            return False, 0.0
        if now - self.last_check_time < self.check_interval:
            return False, 0.0
        self.last_check_time = now

        audio = np.array(list(self.buffer)[-self.sample_rate:], dtype=np.float32)
        rms = np.sqrt(np.mean(audio[:1024] ** 2))
        if rms < self._energy_threshold:
            return False, 0.0

        current_mfcc = self.mfcc.extract(audio)
        if current_mfcc is None:
            return False, 0.0

        max_sim = max(self._cosine_sim(current_mfcc, template) for template in self._templates)
        if self.debug and max_sim > 0.1:
            filled = int(max_sim * 30)
            bar = "#" * filled + "." * (30 - filled)
            print(
                f"\r  [wake:tmpl] {bar} {max_sim:.3f}/{self.threshold:.3f}   ",
                end="",
                flush=True,
            )

        if max_sim >= self.threshold:
            self.last_detection_time = time.time()
            if self.debug:
                print(f"\r  [wake:tmpl] >>> DETECTED ({max_sim:.3f}) <<<" + " " * 20, flush=True)
            return True, max_sim

        return False, max_sim

    def record_templates(self, mic_stream, n_templates=5):
        print(f"\n  Record your wake word '{self.wake_word}' {n_templates} times.")
        print("  Speak naturally at normal volume.")
        print("  Press ENTER when ready...")
        input()

        templates = []
        for i in range(n_templates):
            print(f"\n  Recording {i+1}/{n_templates} — say '{self.wake_word}' after the countdown")
            for c in range(3, 0, -1):
                print(f"   {c}...")
                time.sleep(1)
            print("   SPEAK NOW!")

            audio = np.concatenate([mic_stream.read(500) for _ in range(32)])
            audio = self._trim_silence(audio)
            mfcc = self.mfcc.extract(audio)
            if mfcc is not None:
                templates.append(mfcc)
                for aug_audio in self._augment(audio):
                    aug_mfcc = self.mfcc.extract(aug_audio)
                    if aug_mfcc is not None:
                        templates.append(aug_mfcc)
                print(f"   Got it! ({len(audio)/16000:.1f}s)")
            else:
                print("   Couldn't detect speech. Try again.")
            time.sleep(0.5)

        if templates:
            self._templates = templates
            slug = self.wake_word.replace(" ", "_")
            path = os.path.join(self._models_dir, f"{slug}_templates.pkl")
            with open(path, "wb") as handle:
                pickle.dump(templates, handle)
            print(f"\n  Saved {len(templates)} templates to {path}")
            return True
        return False

    @staticmethod
    def _time_stretch(audio, rate):
        idx = np.round(np.arange(0, len(audio), rate)).astype(int)
        idx = idx[idx < len(audio)]
        return audio[idx]

    @staticmethod
    def _cosine_sim(a, b):
        v1, v2 = a.flatten(), b.flatten()
        min_len = min(len(v1), len(v2))
        v1, v2 = v1[:min_len], v2[:min_len]
        dot = np.dot(v1, v2)
        n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
        return 0.0 if n1 == 0 or n2 == 0 else dot / (n1 * n2)

    @staticmethod
    def _trim_silence(audio, chunk_size=1024, threshold=0.008):
        chunks = [audio[i:i+chunk_size] for i in range(0, len(audio), chunk_size)]
        energies = [np.sqrt(np.mean(chunk ** 2)) for chunk in chunks]

        start = 0
        for i, energy in enumerate(energies):
            if energy > threshold:
                start = max(0, i - 1)
                break

        end = len(chunks)
        for i in range(len(energies) - 1, -1, -1):
            if energies[i] > threshold:
                end = min(len(chunks), i + 2)
                break

        return audio[start * chunk_size:end * chunk_size]

    @staticmethod
    def _augment(audio):
        augmented = []
        for rate in [0.9, 1.1]:
            idx = np.round(np.arange(0, len(audio), rate)).astype(int)
            idx = idx[idx < len(audio)]
            augmented.append(audio[idx])
        for semi in [-2, 2]:
            factor = 2 ** (semi / 12.0)
            idx = np.round(np.arange(0, len(audio), factor)).astype(int)
            idx = idx[idx < len(audio)]
            augmented.append(audio[idx])
        augmented.append(audio * 0.8)
        augmented.append(audio * 1.2)
        augmented.append(audio + np.random.normal(0, 0.003, len(audio)).astype(np.float32))
        augmented.append(audio + np.random.normal(0, 0.006, len(audio)).astype(np.float32))
        return augmented

    def _is_speech_like(self, audio):
        try:
            signs = np.sign(audio)
            signs[signs == 0] = 1
            zcr = np.sum(np.abs(np.diff(signs))) / (2.0 * len(audio))
            if zcr > 0.20 or zcr < 0.002:
                return False

            chunk_size = self.sample_rate // 20
            n_chunks = max(1, len(audio) // chunk_size)
            energies = np.array([
                np.sqrt(np.mean(audio[i * chunk_size:(i + 1) * chunk_size] ** 2))
                for i in range(n_chunks)
            ])
            if len(energies) < 3:
                return True
            energy_cv = np.std(energies) / (np.mean(energies) + 1e-8)
            if energy_cv < 0.15:
                return False

            smooth = np.convolve(energies, np.ones(3) / 3, mode="same")
            threshold = np.mean(smooth) * 0.6
            above = smooth > threshold
            n_peaks = np.sum(np.diff(above.astype(int)) == 1)
            if n_peaks < 1 or n_peaks > 5:
                return False

            return True
        except Exception:
            return True
