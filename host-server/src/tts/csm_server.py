#!/usr/bin/env python3
"""
Persistent CSM (Conversational Speech Model) TTS Server

Runs as a long-lived subprocess, keeping the CSM-1B model loaded in GPU VRAM.
Communicates with the Node.js host via JSON over stdin/stdout.

Protocol:
  → stdin:  {"type": "generate", "text": "...", "speaker": 0, "context": [...]}
  ← stdout: {"type": "audio", "data": "<base64 wav>"}
  ← stdout: {"type": "stats", "duration_ms": 1234, "audio_length_ms": 5000, "vram_mb": 4096}
  ← stdout: {"type": "error", "message": "..."}
  → stdin:  {"type": "shutdown"}

Requirements:
  pip install torch torchaudio transformers>=4.52.1 huggingface_hub
"""

import sys
import os
import json
import time
import base64
import io
import traceback

# Prevent torch.compile issues on Windows
os.environ.setdefault("NO_TORCH_COMPILE", "1")


def log(msg):
    """Log to stderr so it doesn't interfere with JSON stdout protocol."""
    print(f"[csm_server] {msg}", file=sys.stderr, flush=True)


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


class CSMServer:
    def __init__(self):
        self.device = os.environ.get("CSM_DEVICE", "cuda")
        self.max_audio_ms = int(os.environ.get("CSM_MAX_AUDIO_LENGTH_MS", "15000"))
        self.default_speaker = int(os.environ.get("CSM_SPEAKER_ID", "0"))
        self.generator = None
        self.sample_rate = None

    def load_model(self):
        """Load CSM-1B into GPU VRAM."""
        log(f"Loading CSM-1B on device={self.device}...")

        try:
            import torch
            import torchaudio

            # Try HuggingFace Transformers native CSM first (>=4.52.1)
            try:
                from transformers import CsmForConditionalGeneration, AutoTokenizer
                log("Using HuggingFace Transformers CSM integration")
                self._load_hf_csm()
                return
            except ImportError:
                log("HF Transformers CSM not available, using local generator")

            # Fall back to local generator.py from external/csm/
            try:
                sys.path.insert(0, os.getcwd())
                from generator import load_csm_1b
                log("Using local CSM generator (external/csm/)")
                self.generator = load_csm_1b(device=self.device)
                self.sample_rate = self.generator.sample_rate
                self._use_hf = False
                return
            except Exception as e:
                raise RuntimeError(f"Failed to load CSM model: {e}")

        except ImportError as e:
            raise RuntimeError(
                f"Missing dependency: {e}. "
                f"Install with: pip install torch torchaudio transformers>=4.52.1"
            )

    def _load_hf_csm(self):
        """Load CSM via HuggingFace Transformers."""
        import torch
        from transformers import CsmForConditionalGeneration, AutoProcessor

        dtype = torch.float16  # 2080 TI doesn't support bfloat16 natively

        self.hf_model = CsmForConditionalGeneration.from_pretrained(
            "sesame/csm-1b",
            torch_dtype=dtype,
            device_map=self.device,
        )
        self.hf_processor = AutoProcessor.from_pretrained("sesame/csm-1b")
        self.sample_rate = 24000  # CSM outputs 24kHz audio
        self._use_hf = True
        log(f"CSM-1B loaded via HF Transformers (dtype={dtype}, sr={self.sample_rate})")

    def generate(self, text, speaker=None, context=None, max_audio_ms=None):
        """Generate speech audio from text.

        Args:
            text: Text to speak
            speaker: Speaker ID (0 = Clive)
            context: List of {"text": str, "speaker": int, "audio_path": str|None}
            max_audio_ms: Maximum audio length in milliseconds

        Returns:
            WAV audio as bytes
        """
        import torch
        import torchaudio

        speaker = speaker if speaker is not None else self.default_speaker
        max_audio_ms = max_audio_ms or self.max_audio_ms

        if hasattr(self, '_use_hf') and self._use_hf:
            return self._generate_hf(text, speaker, context, max_audio_ms)
        else:
            return self._generate_local(text, speaker, context, max_audio_ms)

    def _generate_local(self, text, speaker, context, max_audio_ms):
        """Generate using the local generator.py."""
        import torch
        import torchaudio

        # Build context segments
        segments = []
        if context:
            from generator import Segment
            for seg in context:
                seg_audio = None
                if seg.get("audio_path") and os.path.exists(seg["audio_path"]):
                    try:
                        audio_tensor, sr = torchaudio.load(seg["audio_path"])
                        seg_audio = torchaudio.functional.resample(
                            audio_tensor.squeeze(0),
                            orig_freq=sr,
                            new_freq=self.sample_rate,
                        )
                    except Exception as e:
                        log(f"Failed to load context audio: {e}")

                if seg_audio is not None:
                    segments.append(Segment(
                        text=seg.get("text", ""),
                        speaker=seg.get("speaker", 0),
                        audio=seg_audio,
                    ))

        # Generate
        audio = self.generator.generate(
            text=text,
            speaker=speaker,
            context=segments,
            max_audio_length_ms=max_audio_ms,
        )

        # Convert to WAV bytes — write to temp file (BytesIO not supported on all backends)
        import tempfile
        tmp_path = os.path.join(tempfile.gettempdir(), "csm_output.wav")
        torchaudio.save(tmp_path, audio.unsqueeze(0).cpu(), self.sample_rate, format="wav")
        with open(tmp_path, "rb") as f:
            return f.read()

    def _generate_hf(self, text, speaker, context, max_audio_ms):
        """Generate using HuggingFace Transformers CSM."""
        import torch
        import torchaudio

        # Build conversation in CSM chat format
        conversation = []

        # Add context turns if provided
        if context:
            for seg in context:
                entry = {
                    "role": str(seg.get("speaker", 0)),
                    "content": [{"type": "text", "text": seg.get("text", "")}],
                }
                # Include audio context if available
                if seg.get("audio_path") and os.path.exists(seg["audio_path"]):
                    try:
                        audio_tensor, sr = torchaudio.load(seg["audio_path"])
                        if sr != self.sample_rate:
                            audio_tensor = torchaudio.functional.resample(
                                audio_tensor, orig_freq=sr, new_freq=self.sample_rate,
                            )
                        entry["content"].append({
                            "type": "audio",
                            "audio": audio_tensor.squeeze(0).numpy(),
                        })
                    except Exception as e:
                        log(f"Failed to load context audio: {e}")
                conversation.append(entry)

        # Add the target utterance (text only — model generates audio for it)
        conversation.append({
            "role": str(speaker),
            "content": [{"type": "text", "text": text}],
        })

        # Tokenize using the processor's chat template
        inputs = self.hf_processor.apply_chat_template(
            conversation,
            tokenize=True,
            return_dict=True,
        ).to(self.device)

        # Cast audio values to match model dtype (float16) — prevents
        # "Input type (float) and bias type (Half) should be the same" error
        if "input_values" in inputs and inputs["input_values"] is not None:
            inputs["input_values"] = inputs["input_values"].to(torch.float16)

        # Generate audio tokens and decode
        # CSM backbone generates 1 token per codec frame (~12.5 frames/sec)
        # The depth decoder then expands each into 32 codebook tokens internally
        # So max_new_tokens ≈ desired_seconds * 12.5
        max_tokens = int(max_audio_ms / 1000 * 12.5)
        log(f"Generating: text='{text[:50]}...', max_tokens={max_tokens}")
        with torch.no_grad():
            audio_outputs = self.hf_model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                output_audio=True,
                do_sample=True,
                temperature=0.9,
                top_k=50,
            )

        # audio_outputs is a list of tensors when output_audio=True
        audio_tensor = audio_outputs[0]  # First (only) batch item

        # Write to temp file — torchaudio BytesIO not supported on all backends
        import tempfile
        tmp_path = os.path.join(tempfile.gettempdir(), "csm_output.wav")
        torchaudio.save(
            tmp_path,
            audio_tensor.unsqueeze(0).cpu().float(),
            self.sample_rate,
            format="wav",
        )
        with open(tmp_path, "rb") as f:
            return f.read()

    def run(self):
        """Main event loop: read JSON from stdin, write JSON to stdout."""
        log("Starting CSM server...")

        try:
            self.load_model()
        except Exception as e:
            send_json({"type": "error", "message": f"Failed to load model: {e}"})
            log(f"FATAL: {traceback.format_exc()}")
            sys.exit(1)

        vram = get_vram_mb()
        send_json({
            "type": "ready",
            "device": self.device,
            "vram_mb": vram,
            "sample_rate": self.sample_rate,
        })

        log(f"Ready. VRAM usage: {vram}MB. Waiting for requests...")

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

            elif req_type == "generate":
                start_time = time.time()
                try:
                    wav_bytes = self.generate(
                        text=request.get("text", ""),
                        speaker=request.get("speaker"),
                        context=request.get("context", []),
                        max_audio_ms=request.get("max_audio_length_ms"),
                    )

                    duration_ms = round((time.time() - start_time) * 1000)
                    audio_length_ms = round(len(wav_bytes) / (self.sample_rate * 2) * 1000)  # 16-bit mono

                    send_json({
                        "type": "audio",
                        "data": base64.b64encode(wav_bytes).decode("ascii"),
                    })
                    send_json({
                        "type": "stats",
                        "duration_ms": duration_ms,
                        "audio_length_ms": audio_length_ms,
                        "vram_mb": get_vram_mb(),
                    })

                except Exception as e:
                    log(f"Generation error: {traceback.format_exc()}")
                    send_json({"type": "error", "message": str(e)})

            elif req_type == "ping":
                send_json({"type": "pong", "vram_mb": get_vram_mb()})

            else:
                send_json({"type": "error", "message": f"Unknown request type: {req_type}"})

        log("Server stopped")


if __name__ == "__main__":
    server = CSMServer()
    server.run()
