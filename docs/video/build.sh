#!/usr/bin/env bash
# Pipeline: scenes.json -> 1080x1920 HTML slides -> PNGs -> offline Kokoro narration -> snapgit-tiktok.mp4
# Usage: ./build.sh [--skip-audio]     Env: PYTHON (interpreter with kokoro-onnx, soundfile, pillow), CHROME
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"; export PYTHON="$PY" VIDEO_DIR="$DIR"
OUT="$DIR/snapgit-tiktok.mp4"; PAD=0.7; FADE=0.25
node "$DIR/render_slides.cjs"
"$DIR/render_pngs.sh"
[ "${1:-}" = "--skip-audio" ] || "$PY" "$DIR/kokoro_tts.py" "$DIR/scenes.json" "$DIR/audio" "${VOICE:-am_michael}" "${SPEED:-1.12}"

SEG="$DIR/.segments"; rm -rf "$SEG"; mkdir -p "$SEG"; : > "$SEG/concat.txt"
for wav in "$DIR"/audio/scene*.wav; do
  id="$(basename "$wav" .wav)"
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$wav")"
  total="$("$PY" -c "print(round(float('$dur') + $PAD, 3))")"
  fade_out="$("$PY" -c "print(round($total - $FADE, 3))")"
  ffmpeg -y -loop 1 -i "$DIR/slides/$id.png" -i "$wav" \
    -filter_complex "[0:v]fade=t=in:d=$FADE,fade=t=out:st=$fade_out:d=$FADE[v];[1:a]acompressor=threshold=-20dB:ratio=3.5:attack=5:release=60,equalizer=f=3200:t=q:w=1:g=3,loudnorm=I=-14:TP=-1.5:LRA=7,apad=pad_dur=$PAD[a]" \
    -map "[v]" -map "[a]" -t "$total" -r 30 -pix_fmt yuv420p -c:v libx264 -c:a aac -shortest \
    "$SEG/$id.mp4" -loglevel error
  echo "file '$SEG/$id.mp4'" >> "$SEG/concat.txt"
  echo "segment $id ($total s)"
done
ffmpeg -y -f concat -safe 0 -i "$SEG/concat.txt" -c copy "$OUT" -loglevel error
echo "Final video: $OUT"; ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
