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
    # scenes.json spells things out for the old Festival voice; undo that.
    text = re.sub(r"obsidian dash M C P dash server", "obsidian-mcp-server", text)
    text = re.sub(r"M C P dash obsidian", "MCP obsidian", text)
    text = text.replace("M C P", "MCP")
    text = text.replace("setup-vault dot s h", "setup-vault.sh")
    return text

def main():
    scenes_path, out_dir = sys.argv[1], sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else "af_heart"
    speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    fetch()
    k = Kokoro(os.path.join(MODELS, FILES[0]), os.path.join(MODELS, FILES[1]))
    os.makedirs(out_dir, exist_ok=True)
    for s in json.load(open(scenes_path)):
        samples, sr = k.create(speakable(s["narration"]), voice=voice, speed=speed, lang="en-us")
        out = os.path.join(out_dir, s["id"] + ".wav")
        sf.write(out, samples, sr)
        print("generated", out, f"[kokoro:{voice}]")

if __name__ == "__main__":
    main()
