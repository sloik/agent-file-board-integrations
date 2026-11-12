#!/bin/sh
# Renders a cropped ANSI pane capture to PNG for the docs (macOS).
# freeze lays out the terminal as SVG; Quick Look (WebKit) rasterizes it, so emoji
# (the signature badges) use the system emoji font instead of rendering as boxes.
# Quick Look makes a square thumbnail with the image at the top; png-top.py keeps that part.
# Usage: scripts/render-shot.sh <capture.ansi> <out.png>
set -eu
IN=$1; OUT=$2
TMP=$(mktemp -d "${TMPDIR:-/tmp}/afb-shot.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
freeze "$IN" --language ansi --window --padding 20 --font.size 14 -o "$TMP/shot.svg" </dev/null >/dev/null  # freeze reads a piped stdin in preference to the file
W=$(sed -n 's/.*<svg width="\([0-9.]*\)" height="\([0-9.]*\)".*/\1/p' "$TMP/shot.svg" | head -1)
H=$(sed -n 's/.*<svg width="\([0-9.]*\)" height="\([0-9.]*\)".*/\2/p' "$TMP/shot.svg" | head -1)
PW=$(awk "BEGIN{printf \"%d\", $W*2}"); PH=$(awk "BEGIN{printf \"%d\", $H*2}")
qlmanage -t -s "$PW" -o "$TMP" "$TMP/shot.svg" >/dev/null 2>&1
[ -s "$TMP/shot.svg.png" ] || { echo "render-shot: Quick Look wrote no image" >&2; exit 1; }
python3 "$(dirname "$0")/png-top.py" "$TMP/shot.svg.png" "$PH" "$OUT"
echo "wrote $OUT (${PW}x${PH})"
