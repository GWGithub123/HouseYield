#!/usr/bin/env python3

import base64
import io
import json
import os
import sys
import tempfile

import numpy as np

try:
    import torch
    import torchaudio
    import soundfile as sf
    from speechbrain.inference.speaker import EncoderClassifier
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "error": "voice_identity_dependency_error",
        "message": str(exc),
    }))
    sys.exit(1)


VOICE_IDENTITY_MODEL = os.environ.get("HOUSEYIELD_VOICE_ID_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
VOICE_IDENTITY_MODEL_DIR = os.environ.get(
    "HOUSEYIELD_VOICE_ID_MODEL_DIR",
    os.path.join(tempfile.gettempdir(), "houseyield-voice-identity-model"),
)

_CLASSIFIER = None


def get_classifier():
    global _CLASSIFIER
    if _CLASSIFIER is None:
        _CLASSIFIER = EncoderClassifier.from_hparams(
            source=VOICE_IDENTITY_MODEL,
            savedir=VOICE_IDENTITY_MODEL_DIR,
            run_opts={"device": "cpu"},
        )
    return _CLASSIFIER


def decode_audio_bytes(audio_base64: str) -> bytes:
    if not isinstance(audio_base64, str) or not audio_base64.strip():
        raise ValueError("audioBase64 is required")

    payload = audio_base64.split(",", 1)[1] if audio_base64.startswith("data:") else audio_base64
    return base64.b64decode(payload)


def embed_audio(audio_bytes: bytes):
    temp_path = None
    try:
        waveform_array, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
        waveform = torch.from_numpy(np.asarray(waveform_array, dtype=np.float32))

        if waveform.ndim == 1:
            waveform = waveform.unsqueeze(0)
        elif waveform.ndim == 2:
            waveform = waveform.transpose(0, 1)

        if waveform.size(0) > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)

        duration_seconds = float(waveform.size(-1)) / float(sample_rate)

        if sample_rate != 16000:
            waveform = torchaudio.functional.resample(waveform, sample_rate, 16000)
            sample_rate = 16000

        classifier = get_classifier()
        with torch.no_grad():
            embedding = classifier.encode_batch(waveform).squeeze().cpu().numpy()

        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        return {
            "ok": True,
            "embedding": embedding.astype(float).tolist(),
            "durationSeconds": round(duration_seconds, 3),
            "sampleRate": sample_rate,
            "engine": VOICE_IDENTITY_MODEL,
        }
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    if payload.get("action") != "embed":
        raise ValueError("Unsupported action")

    audio_bytes = decode_audio_bytes(payload.get("audioBase64", ""))
    print(json.dumps(embed_audio(audio_bytes)))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": "voice_identity_embed_failed",
            "message": str(exc),
        }))
        sys.exit(1)