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

# The phonemizer mangles spelled-out letters ("A I" -> "uh eye", "ay eye" -> "eye eye"), so acronyms are
# spliced in as explicit IPA letter names: A = "ay", I = "eye", C = "see", P = "pee"...
LETTERS = {"A": "ˈeɪ", "I": "ˈaɪ", "C": "sˈiː", "P": "pˈiː", "L": "ˈɛl", "G": "dʒˈiː", "T": "tˈiː", "M": "ˈɛm"}
ACRONYM = re.compile(r"\b((?:[ACIPLGTM] )+[ACIPLGTM])\b('s)?")

def speakable(text):
    """Scene text for the ear: the brand name is two words."""
    return re.sub(r"\bsnapgit\b", "snap git", text, flags=re.I)

def to_phonemes(k, text):
    """Phonemize normally, but speak acronyms as letter names. Possessive 's becomes a plain z."""
    out, pos = [], 0
    for m in ACRONYM.finditer(text):
        before = text[pos:m.start()].strip()
        if before:
            out.append(k.tokenizer.phonemize(speakable(before), "en-us"))
        letters = " ".join(LETTERS[c] for c in m.group(1).split())
        out.append(letters + ("z" if m.group(2) else ""))
        pos = m.end()
    rest = text[pos:].strip()
    if rest:
        out.append(k.tokenizer.phonemize(speakable(rest), "en-us"))
    return " ".join(out)

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
            samples, sr = k.create(to_phonemes(k, piece.strip()), voice=voice, speed=speed, lang="en-us", is_phonemes=True)
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
