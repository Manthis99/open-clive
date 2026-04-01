#!/usr/bin/env python3
"""
Train a "Hey Clive" wake word ONNX model using synthetic TTS data.

Generates diverse voice samples via edge-tts, augments them,
trains a small 1D CNN, and exports to ONNX (~100KB).
The resulting model runs on Pi/desktop via onnxruntime.

Usage:
  pip install edge-tts numpy scipy soundfile onnx onnxruntime
  python train_wake_word.py
  python train_wake_word.py --wake-word "hey clive" --epochs 2000

Output: ../models/hey_clive.onnx
"""

import os
import sys
import time
import random
import asyncio
import tempfile
import argparse
import warnings
import numpy as np
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.filterwarnings("ignore")

# Add parent for wake_word module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from wake_word import MFCCExtractor, TARGET_FRAMES

try:
    import soundfile as sf
except ImportError:
    print("pip install soundfile")
    sys.exit(1)

try:
    import edge_tts
except ImportError:
    print("pip install edge-tts")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────

SAMPLE_RATE = 16000
N_MFCC = 13
N_FEATURES = 39  # MFCC + delta + delta-delta
EPOCHS = 2000
BATCH_SIZE = 64
LR = 0.001

# TTS voices to use for positive samples
VOICE_LIST = [
    "en-US-GuyNeural", "en-US-JennyNeural", "en-US-AriaNeural",
    "en-US-DavisNeural", "en-US-AmberNeural", "en-US-AnaNeural",
    "en-US-AndrewNeural", "en-US-BrandonNeural", "en-US-ChristopherNeural",
    "en-US-CoraNeural", "en-US-ElizabethNeural", "en-US-EricNeural",
    "en-US-JacobNeural", "en-US-MichelleNeural", "en-US-MonicaNeural",
    "en-US-RogerNeural", "en-US-SteffanNeural",
    "en-GB-RyanNeural", "en-GB-SoniaNeural", "en-GB-LibbyNeural",
    "en-GB-ThomasNeural", "en-GB-MaisieNeural",
    "en-AU-NatashaNeural", "en-AU-WilliamNeural",
    "en-IN-NeerjaNeural", "en-IN-PrabhatNeural",
    "en-CA-ClaraNeural", "en-CA-LiamNeural",
    "en-IE-ConnorNeural", "en-IE-EmilyNeural",
]

# Confusable phrases for hard negatives
HARD_NEGATIVES = [
    "hey there", "hey slide", "hey live", "hey five",
    "hey guys", "hey siri", "hey google", "hey jive",
    "hey give", "hey drive", "hey dive", "hey hive",
    "a clive", "the clive", "hey cliff", "hey alive",
    "hey arrive", "hey derive", "play live", "say hi",
    "hey chloe", "hey clever", "hey climb", "hey client",
    "hey class", "hey close", "hey cloud", "hey clock",
    "good bye", "hey nine", "hey mine", "hey fine",
    "hey time", "hey line", "hey vine", "hey wine",
    "hey crime", "hey dime", "hey lime", "hey rhyme",
]


# ── TTS Generation ────────────────────────────────────────────────

async def generate_tts(text, voice, output_path):
    """Generate a WAV file using edge-tts."""
    try:
        comm = edge_tts.Communicate(text, voice)
        mp3_path = output_path + ".mp3"
        await comm.save(mp3_path)

        # Convert MP3 to WAV at 16kHz
        import subprocess
        # Find ffmpeg — check common locations
        ffmpeg = "ffmpeg"
        home = os.path.expanduser("~")
        for candidate in [
            os.path.join(home, r"AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"),
            r"C:\ffmpeg\bin\ffmpeg.exe",
            "ffmpeg",
        ]:
            expanded = os.path.expandvars(candidate)
            if os.path.exists(expanded):
                ffmpeg = expanded
                break

        result = subprocess.run(
            [ffmpeg, "-y", "-i", mp3_path, "-ar", str(SAMPLE_RATE),
             "-ac", "1", "-f", "wav", output_path],
            capture_output=True, timeout=10,
        )
        try:
            os.remove(mp3_path)
        except OSError:
            pass
        if result.returncode == 0 and os.path.exists(output_path):
            return True
    except Exception as e:
        pass
    return False


async def generate_samples(text, n_voices=20, prefix="pos"):
    """Generate TTS samples for a phrase across multiple voices."""
    voices = random.sample(VOICE_LIST, min(n_voices, len(VOICE_LIST)))
    tmp_dir = tempfile.mkdtemp(prefix="clive_ww_")
    samples = []

    print(f"  Generating TTS for '{text}' with {len(voices)} voices...")
    tasks = []
    for i, voice in enumerate(voices):
        out_path = os.path.join(tmp_dir, f"{prefix}_{i}.wav")
        tasks.append((text, voice, out_path))

    for text, voice, path in tasks:
        success = await generate_tts(text, voice, path)
        if success:
            audio, sr = sf.read(path)
            if sr != SAMPLE_RATE:
                from scipy.signal import resample
                audio = resample(audio, int(len(audio) * SAMPLE_RATE / sr))
            samples.append(audio.astype(np.float32))

    print(f"  Generated {len(samples)} samples")
    return samples


# ── Augmentation ──────────────────────────────────────────────────

def augment(audio, n_augments=10):
    """Create augmented versions of audio."""
    results = [audio]
    for _ in range(n_augments):
        aug = audio.copy()
        # Random time stretch
        if random.random() < 0.5:
            rate = random.uniform(0.85, 1.15)
            idx = np.round(np.arange(0, len(aug), rate)).astype(int)
            idx = idx[idx < len(aug)]
            aug = aug[idx]
        # Random volume
        if random.random() < 0.5:
            aug = aug * random.uniform(0.6, 1.4)
        # Random noise
        if random.random() < 0.5:
            aug = aug + np.random.normal(0, random.uniform(0.001, 0.01),
                                          len(aug)).astype(np.float32)
        # Random pitch shift
        if random.random() < 0.3:
            factor = 2 ** (random.uniform(-3, 3) / 12.0)
            idx = np.round(np.arange(0, len(aug), factor)).astype(int)
            idx = idx[idx < len(aug)]
            aug = aug[idx]
        results.append(aug)
    return results


def generate_noise_negatives(n=100):
    """Generate synthetic noise clips as negative samples."""
    clips = []
    sr = SAMPLE_RATE
    n_samples = sr  # 1 second

    for _ in range(n):
        noise_type = random.choice(['white', 'pink', 'babble', 'tonal', 'rumble', 'mixed'])

        if noise_type == 'white':
            clip = np.random.randn(n_samples).astype(np.float32) * random.uniform(0.01, 0.1)
        elif noise_type == 'pink':
            white = np.random.randn(n_samples).astype(np.float32)
            fft = np.fft.rfft(white)
            freqs = np.fft.rfftfreq(n_samples, d=1.0/sr)
            freqs[0] = 1.0
            fft /= np.sqrt(freqs)
            clip = np.fft.irfft(fft, n=n_samples).astype(np.float32)
            clip *= random.uniform(0.01, 0.08) / (np.std(clip) + 1e-8)
        elif noise_type == 'babble':
            clip = np.zeros(n_samples, dtype=np.float32)
            for _ in range(random.randint(2, 5)):
                f0 = random.uniform(80, 300)
                t = np.arange(n_samples) / sr
                voice = sum(
                    np.sin(2 * np.pi * f0 * h * t).astype(np.float32) / h
                    for h in range(1, random.randint(3, 7))
                )
                env = np.interp(
                    np.linspace(0, 19, n_samples),
                    np.arange(20), np.random.rand(20),
                ).astype(np.float32)
                clip += voice * env
            clip *= random.uniform(0.01, 0.06) / (np.std(clip) + 1e-8)
        elif noise_type == 'tonal':
            t = np.arange(n_samples) / sr
            freq = random.choice([261, 330, 392, 440, 523]) * random.choice([0.5, 1.0, 2.0])
            clip = np.sin(2 * np.pi * freq * t).astype(np.float32) * random.uniform(0.01, 0.05)
        elif noise_type == 'rumble':
            t = np.arange(n_samples) / sr
            clip = np.sin(2 * np.pi * random.uniform(20, 120) * t).astype(np.float32)
            clip += np.random.randn(n_samples).astype(np.float32) * 0.02
            clip *= random.uniform(0.02, 0.08)
        else:  # mixed
            clip = np.random.randn(n_samples).astype(np.float32) * 0.03
            t = np.arange(n_samples) / sr
            clip += np.sin(2 * np.pi * random.uniform(100, 1000) * t).astype(np.float32) * 0.02

        clips.append(clip[:n_samples])
    return clips


# ── 1D CNN (numpy) ────────────────────────────────────────────────

def _relu(x): return np.maximum(0, x)
def _sigmoid(x): return 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))

def _conv1d(x, W, b):
    batch, T, C_in = x.shape
    K, _, C_out = W.shape
    T_out = T - K + 1
    cols = np.zeros((batch, T_out, K * C_in), dtype=x.dtype)
    for t in range(T_out):
        cols[:, t, :] = x[:, t:t+K, :].reshape(batch, -1)
    return cols @ W.reshape(K * C_in, C_out) + b

def _conv1d_backward(x, W, dout):
    batch, T, C_in = x.shape
    K, _, C_out = W.shape
    T_out = T - K + 1
    cols = np.zeros((batch, T_out, K * C_in), dtype=x.dtype)
    for t in range(T_out):
        cols[:, t, :] = x[:, t:t+K, :].reshape(batch, -1)
    dW = np.einsum('bti,bto->io', cols, dout).reshape(K, C_in, C_out)
    db = dout.sum(axis=(0, 1))
    dcols = dout @ W.reshape(K * C_in, C_out).T
    dx = np.zeros_like(x)
    for t in range(T_out):
        dx[:, t:t+K, :] += dcols[:, t, :].reshape(batch, K, C_in)
    return dW, db, dx

def _maxpool1d(x, pool_size=2):
    batch, T, C = x.shape
    T_out = T // pool_size
    return x[:, :T_out * pool_size, :].reshape(batch, T_out, pool_size, C).max(axis=2)

def _maxpool1d_backward(x, out, dout, pool_size=2):
    batch, T, C = x.shape
    T_out = T // pool_size
    x_trunc = x[:, :T_out * pool_size, :].reshape(batch, T_out, pool_size, C)
    mask = (x_trunc == out[:, :, np.newaxis, :])
    dx = np.zeros_like(x)
    dx[:, :T_out * pool_size, :] = (mask * dout[:, :, np.newaxis, :]).reshape(batch, T_out * pool_size, C)
    return dx


class TinyWakeWordCNN:
    """1D CNN for wake word classification.
    Conv(k=5,32) → ReLU → MaxPool(2) → Conv(k=3,64) → ReLU → MaxPool(2)
    → GlobalAvgPool → FC(64) → ReLU → FC(1) → Sigmoid
    """

    def __init__(self, n_frames=TARGET_FRAMES, n_features=N_FEATURES):
        self.n_frames = n_frames
        self.n_features = n_features
        self.W_c1 = np.random.randn(5, n_features, 32).astype(np.float32) * np.sqrt(2.0 / (5 * n_features))
        self.b_c1 = np.zeros(32, dtype=np.float32)
        self.W_c2 = np.random.randn(3, 32, 64).astype(np.float32) * np.sqrt(2.0 / (3 * 32))
        self.b_c2 = np.zeros(64, dtype=np.float32)
        self.W_f1 = np.random.randn(64, 64).astype(np.float32) * np.sqrt(2.0 / 64)
        self.b_f1 = np.zeros(64, dtype=np.float32)
        self.W_f2 = np.random.randn(64, 1).astype(np.float32) * np.sqrt(2.0 / 64)
        self.b_f2 = np.zeros(1, dtype=np.float32)

    def forward(self, X):
        self._x = X
        self._z1 = _conv1d(X, self.W_c1, self.b_c1)
        self._a1 = _relu(self._z1)
        self._p1 = _maxpool1d(self._a1, 2)
        self._z2 = _conv1d(self._p1, self.W_c2, self.b_c2)
        self._a2 = _relu(self._z2)
        self._p2 = _maxpool1d(self._a2, 2)
        self._gap = self._p2.mean(axis=1)
        self._zf1 = self._gap @ self.W_f1 + self.b_f1
        self._af1 = _relu(self._zf1)
        self._zf2 = self._af1 @ self.W_f2 + self.b_f2
        return _sigmoid(self._zf2)

    def backward(self, X, y, pred):
        bs = X.shape[0]
        dz2 = (pred - y) / bs
        dW_f2 = self._af1.T @ dz2
        db_f2 = dz2.sum(axis=0)
        da1 = dz2 @ self.W_f2.T
        dz1 = da1 * (self._zf1 > 0).astype(np.float32)
        dW_f1 = self._gap.T @ dz1
        db_f1 = dz1.sum(axis=0)
        T2 = self._p2.shape[1]
        d_p2 = np.repeat((dz1 @ self.W_f1.T)[:, np.newaxis, :], T2, axis=1) / T2
        d_a2 = _maxpool1d_backward(self._a2, self._p2, d_p2, 2)
        d_z2 = d_a2 * (self._z2 > 0).astype(np.float32)
        dW_c2, db_c2, d_p1 = _conv1d_backward(self._p1, self.W_c2, d_z2)
        d_a1 = _maxpool1d_backward(self._a1, self._p1, d_p1, 2)
        d_z1 = d_a1 * (self._z1 > 0).astype(np.float32)
        dW_c1, db_c1, _ = _conv1d_backward(X, self.W_c1, d_z1)
        return [dW_c1, db_c1, dW_c2, db_c2, dW_f1, db_f1, dW_f2, db_f2]

    def train(self, X, y, epochs=EPOCHS, lr=LR, batch_size=BATCH_SIZE):
        n = len(X)
        params = [self.W_c1, self.b_c1, self.W_c2, self.b_c2,
                  self.W_f1, self.b_f1, self.W_f2, self.b_f2]
        ms = [np.zeros_like(p) for p in params]
        vs = [np.zeros_like(p) for p in params]
        best_acc = 0

        for epoch in range(epochs):
            idx = np.random.permutation(n)
            X_s, y_s = X[idx], y[idx]
            epoch_loss = 0
            n_batches = 0

            for start in range(0, n, batch_size):
                Xb = X_s[start:start+batch_size]
                yb = y_s[start:start+batch_size].reshape(-1, 1)
                pred = self.forward(Xb)
                pred_clip = np.clip(pred, 1e-7, 1-1e-7)
                loss = -np.mean(yb * np.log(pred_clip) + (1 - yb) * np.log(1 - pred_clip))
                epoch_loss += loss
                n_batches += 1
                grads = self.backward(Xb, yb, pred)

                t = epoch * (n // batch_size) + n_batches
                for i, (p, g) in enumerate(zip(params, grads)):
                    ms[i] = 0.9 * ms[i] + 0.1 * g
                    vs[i] = 0.999 * vs[i] + 0.001 * (g ** 2)
                    m_hat = ms[i] / (1 - 0.9 ** max(t, 1))
                    v_hat = vs[i] / (1 - 0.999 ** max(t, 1))
                    p -= lr * m_hat / (np.sqrt(v_hat) + 1e-8)

            if (epoch + 1) % 100 == 0:
                preds = self.forward(X)
                acc = np.mean((preds.flatten() > 0.5) == y)
                avg_loss = epoch_loss / max(n_batches, 1)
                print(f"  Epoch {epoch+1}/{epochs}: loss={avg_loss:.4f} acc={acc:.1%}")
                if acc > best_acc:
                    best_acc = acc

        print(f"  Best accuracy: {best_acc:.1%}")

    def export_onnx(self, output_path, meta_path=None):
        """Export model to ONNX format."""
        try:
            import onnx
            from onnx import helper, TensorProto, numpy_helper
        except ImportError:
            print("pip install onnx")
            return False

        # Build ONNX graph manually (matches forward pass)
        # Input
        X = helper.make_tensor_value_info("input", TensorProto.FLOAT,
                                           [1, self.n_frames, self.n_features])
        Y = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 1])

        # Weight tensors
        initializers = [
            numpy_helper.from_array(self.W_c1.transpose(2, 1, 0), "W_c1"),  # ONNX wants (out, in, k)
            numpy_helper.from_array(self.b_c1, "b_c1"),
            numpy_helper.from_array(self.W_c2.transpose(2, 1, 0), "W_c2"),
            numpy_helper.from_array(self.b_c2, "b_c2"),
            numpy_helper.from_array(self.W_f1.T, "W_f1"),
            numpy_helper.from_array(self.b_f1, "b_f1"),
            numpy_helper.from_array(self.W_f2.T, "W_f2"),
            numpy_helper.from_array(self.b_f2, "b_f2"),
        ]

        # We'll use a simpler approach — export via onnxruntime's own format
        # by creating a trace through the numpy model
        print(f"  Saving ONNX model to {output_path}")

        # Actually, let's use the numpy weights directly with onnxruntime
        # Save as a pickle that OnnxWakeWordModel can load via onnxruntime
        # For proper ONNX, we need torch. Let's try:
        try:
            import torch
            import torch.nn as nn

            class TorchModel(nn.Module):
                def __init__(self, np_model):
                    super().__init__()
                    # Conv1: (out_ch, in_ch, kernel)
                    self.conv1 = nn.Conv1d(np_model.n_features, 32, 5, bias=True)
                    self.conv1.weight.data = torch.from_numpy(
                        np_model.W_c1.transpose(2, 1, 0).copy()
                    )
                    self.conv1.bias.data = torch.from_numpy(np_model.b_c1.copy())

                    self.conv2 = nn.Conv1d(32, 64, 3, bias=True)
                    self.conv2.weight.data = torch.from_numpy(
                        np_model.W_c2.transpose(2, 1, 0).copy()
                    )
                    self.conv2.bias.data = torch.from_numpy(np_model.b_c2.copy())

                    self.fc1 = nn.Linear(64, 64)
                    self.fc1.weight.data = torch.from_numpy(np_model.W_f1.T.copy())
                    self.fc1.bias.data = torch.from_numpy(np_model.b_f1.copy())

                    self.fc2 = nn.Linear(64, 1)
                    self.fc2.weight.data = torch.from_numpy(np_model.W_f2.T.copy())
                    self.fc2.bias.data = torch.from_numpy(np_model.b_f2.copy())

                def forward(self, x):
                    # x: (batch, frames, features) -> conv expects (batch, features, frames)
                    x = x.transpose(1, 2)
                    x = torch.relu(self.conv1(x))
                    x = torch.max_pool1d(x, 2)
                    x = torch.relu(self.conv2(x))
                    x = torch.max_pool1d(x, 2)
                    x = x.mean(dim=2)  # Global avg pool
                    x = torch.relu(self.fc1(x))
                    x = torch.sigmoid(self.fc2(x))
                    return x

            # Force all weights to float32 before export
            self.W_c1 = self.W_c1.astype(np.float32)
            self.b_c1 = self.b_c1.astype(np.float32)
            self.W_c2 = self.W_c2.astype(np.float32)
            self.b_c2 = self.b_c2.astype(np.float32)
            self.W_f1 = self.W_f1.astype(np.float32)
            self.b_f1 = self.b_f1.astype(np.float32)
            self.W_f2 = self.W_f2.astype(np.float32)
            self.b_f2 = self.b_f2.astype(np.float32)

            torch_model = TorchModel(self)
            torch_model.eval()
            dummy = torch.randn(1, self.n_frames, self.n_features)
            torch.onnx.export(
                torch_model, dummy, output_path,
                input_names=["input"], output_names=["output"],
                dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
                opset_version=13,
            )
            print(f"  ONNX model saved ({os.path.getsize(output_path) / 1024:.0f} KB)")

            # Save metadata
            if meta_path:
                import json
                meta = {
                    "wake_word": args.wake_word if 'args' in dir() else "hey clive",
                    "n_frames": self.n_frames,
                    "n_features": self.n_features,
                    "sample_rate": SAMPLE_RATE,
                }
                with open(meta_path, "w") as f:
                    json.dump(meta, f, indent=2)

            return True
        except ImportError:
            print("  torch not available for ONNX export.")
            print("  Saving numpy weights instead (can be loaded directly).")
            import pickle
            weights_path = output_path.replace(".onnx", "_weights.pkl")
            with open(weights_path, "wb") as f:
                pickle.dump({
                    'n_frames': self.n_frames, 'n_features': self.n_features,
                    'W_c1': self.W_c1, 'b_c1': self.b_c1,
                    'W_c2': self.W_c2, 'b_c2': self.b_c2,
                    'W_f1': self.W_f1, 'b_f1': self.b_f1,
                    'W_f2': self.W_f2, 'b_f2': self.b_f2,
                }, f)
            print(f"  Weights saved to {weights_path}")
            return True


# ── Main ──────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="Train Clive wake word model")
    parser.add_argument("--wake-word", default="hey clive")
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--voices", type=int, default=20,
                        help="Number of TTS voices for positive samples")
    parser.add_argument("--hard-negatives", type=int, default=40,
                        help="Number of confusable phrases")
    parser.add_argument("--noise-negatives", type=int, default=100)
    global args
    args = parser.parse_args()

    models_dir = os.path.join(os.path.dirname(__file__), "..", "models")
    os.makedirs(models_dir, exist_ok=True)
    slug = args.wake_word.replace(" ", "_")

    print("=" * 50)
    print(f"  Training wake word model: '{args.wake_word}'")
    print("=" * 50)

    mfcc = MFCCExtractor(sample_rate=SAMPLE_RATE)

    # ── Generate positive samples ──
    print("\n[1/5] Generating positive samples...")
    pos_audio = await generate_samples(args.wake_word, n_voices=args.voices, prefix="pos")

    # Also generate variations with different phrasing
    variations = [args.wake_word, args.wake_word.title(), args.wake_word.upper()]
    for var in variations[1:]:
        extra = await generate_samples(var, n_voices=5, prefix="pos_var")
        pos_audio.extend(extra)

    # Augment
    print(f"  Augmenting {len(pos_audio)} positive samples...")
    all_pos = []
    for audio in pos_audio:
        all_pos.extend(augment(audio, n_augments=10))
    print(f"  Total positive samples: {len(all_pos)}")

    # ── Generate hard negatives ──
    print("\n[2/5] Generating hard negatives...")
    neg_phrases = random.sample(HARD_NEGATIVES, min(args.hard_negatives, len(HARD_NEGATIVES)))
    all_neg_audio = []
    for phrase in neg_phrases:
        neg_audio = await generate_samples(phrase, n_voices=3, prefix="neg")
        for audio in neg_audio:
            all_neg_audio.extend(augment(audio, n_augments=3))
    print(f"  Total hard negative samples: {len(all_neg_audio)}")

    # ── Generate noise negatives ──
    print("\n[3/5] Generating noise negatives...")
    noise_clips = generate_noise_negatives(args.noise_negatives)
    all_neg_audio.extend(noise_clips)
    print(f"  Total negative samples: {len(all_neg_audio)}")

    # ── Extract features ──
    print("\n[4/5] Extracting MFCC features...")
    X_pos, X_neg = [], []

    for audio in all_pos:
        feat = mfcc.extract_fixed(audio, TARGET_FRAMES, use_deltas=True)
        if feat is not None:
            X_pos.append(feat)

    for audio in all_neg_audio:
        feat = mfcc.extract_fixed(audio, TARGET_FRAMES, use_deltas=True)
        if feat is not None:
            X_neg.append(feat)

    print(f"  Positive features: {len(X_pos)}")
    print(f"  Negative features: {len(X_neg)}")

    if len(X_pos) < 10 or len(X_neg) < 10:
        print("ERROR: Not enough samples. Check TTS generation and ffmpeg.")
        return

    # Balance dataset
    min_count = min(len(X_pos), len(X_neg))
    if len(X_pos) > min_count * 2:
        X_pos = random.sample(X_pos, min_count * 2)
    if len(X_neg) > min_count * 2:
        X_neg = random.sample(X_neg, min_count * 2)

    X = np.array(X_pos + X_neg, dtype=np.float32)
    y = np.array([1.0] * len(X_pos) + [0.0] * len(X_neg), dtype=np.float32)

    print(f"  Training set: {len(X)} samples ({len(X_pos)} pos, {len(X_neg)} neg)")

    # ── Train ──
    print(f"\n[5/5] Training CNN ({args.epochs} epochs)...")
    model = TinyWakeWordCNN(n_frames=TARGET_FRAMES, n_features=N_FEATURES)
    model.train(X, y, epochs=args.epochs)

    # ── Export ──
    onnx_path = os.path.join(models_dir, f"{slug}.onnx")
    meta_path = os.path.join(models_dir, f"{slug}_meta.json")
    model.export_onnx(onnx_path, meta_path)

    print(f"\nDone! Model saved to: {onnx_path}")
    print(f"Start the listener with: python listener.py --wake-word \"{args.wake_word}\"")


if __name__ == "__main__":
    asyncio.run(main())
