#!/usr/bin/env bash
# Screenshots slides/sceneNN.html to 1080x1920 PNGs. Headless Chromium's window includes
# ~87px of chrome, so render taller and crop.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"
CHROME="$("$DIR/find_chrome.sh")" || { echo "No Chrome/Chromium found; set CHROME=/path/to/binary" >&2; exit 1; }
SLIDES_DIR="${VIDEO_DIR:-$DIR}/slides"
for f in "$SLIDES_DIR"/scene*.html; do
  name="$(basename "$f" .html)"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1080,2007 --screenshot="$SLIDES_DIR/$name.raw.png" "file://$f" >/dev/null 2>&1
  "$PY" -c "from PIL import Image; Image.open('$SLIDES_DIR/$name.raw.png').crop((0,0,1080,1920)).save('$SLIDES_DIR/$name.png')"
  rm -f "$SLIDES_DIR/$name.raw.png"
  echo "rendered $name"
done
