#!/usr/bin/env bash
# Prints the path of a usable Chrome/Chromium binary, honoring $CHROME.
# Exits 1 if none is found.
set -u
cands=(
  "${CHROME:-}"
  /opt/pw-browsers/chromium-*/chrome-linux/chrome
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
)
for c in "${cands[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; exit 0; }
done
for n in google-chrome google-chrome-stable chromium chromium-browser chrome; do
  command -v "$n" && exit 0
done
exit 1
