#!/usr/bin/env python3
"""Neural offline TTS (Kokoro-82M via kokoro-onnx). Not a clone of anyone's voice.

Usage: kokoro_tts.py SCENES_JSON OUT_DIR [VOICE] [SPEED]
Models (~350 MB) are downloaded once into docs/video/.models/ (gitignored).
"""
import json, os, re, sys, urllib.request
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, ".models")
BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]

def fetch():
    os.makedirs(MODELS, exist_ok=True)
    for f in FILES:
        p = os.path.join(MODELS, f)
        if not os.path.exists(p):
            print("downloading", f)
            urllib.request.urlretrieve(BASE + f, p)

def speakable(text):
    """Spell out what the voice gets wrong. Narration in scenes.json stays readable; this is only for the ear."""
    text = re.sub(r"\bA P I\b", "ay pee eye", text)
    text = re.sub(r"\bA I\b", "ay eye", text)
    text = re.sub(r"\bC I\b", "see eye", text)
    text = re.sub(r"\bL G T M\b", "el gee tee em", text)
    text = re.sub(r"\bsnapgit\b", "snap git", text, flags=re.I)
    return text

PAUSE = re.compile(r"\[pause ([0-9.]+)\]")

def synth(k, text, voice, speed):
    """Narration may contain [pause 1.2] markers: synthesise each part and put real silence between them."""
    import numpy as np
    parts, sr = [], 24000
    pieces = PAUSE.split(text)  # text, secs, text, secs, ...
    for i, piece in enumerate(pieces):
        if i % 2 == 1:
            parts.append(np.zeros(int(float(piece) * sr), dtype="float32"))
        elif piece.strip():
            samples, sr = k.create(speakable(piece.strip()), voice=voice, speed=speed, lang="en-us")
            parts.append(samples)
    return np.concatenate(parts), sr

def main():
    scenes_path, out_dir = sys.argv[1], sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else "af_heart"
    speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    fetch()
    k = Kokoro(os.path.join(MODELS, FILES[0]), os.path.join(MODELS, FILES[1]))
    os.makedirs(out_dir, exist_ok=True)
    for s in json.load(open(scenes_path)):
        samples, sr = synth(k, s["narration"], voice, speed)
        out = os.path.join(out_dir, s["id"] + ".wav")
        sf.write(out, samples, sr)
        print("generated", out, f"[kokoro:{voice}]")

if __name__ == "__main__":
    main()
