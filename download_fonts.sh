#!/usr/bin/env bash
# Download OpenMapTiles PBF font files for self-hosting.
# After running, the glyphs URL in index.html can be changed to:
#   http://localhost:8080/fonts/{fontstack}/{range}.pbf
set -euo pipefail

FONTS_DIR="/home/mo/lidar/viewer/fonts"
mkdir -p "$FONTS_DIR"

# Font names needed by the viewer
FONTS=("Open Sans Regular" "Open Sans Bold")

# OpenMapTiles fonts GitHub release
BASE="https://github.com/openmaptiles/fonts/releases/latest/download"

for FONT in "${FONTS[@]}"; do
  ENCODED="${FONT// /%20}"
  DIR="$FONTS_DIR/$FONT"
  mkdir -p "$DIR"
  echo "Downloading: $FONT"
  # Unicode ranges: 0-255, 256-511, … up to 65280-65535 (256 files)
  for START in $(seq 0 256 65280); do
    END=$((START + 255))
    FILE="$DIR/${START}-${END}.pbf"
    if [ ! -f "$FILE" ]; then
      curl -sfL "${BASE}/${ENCODED}/${START}-${END}.pbf" -o "$FILE" || true
    fi
  done
  COUNT=$(ls "$DIR"/*.pbf 2>/dev/null | wc -l)
  echo "  $COUNT PBF files in $DIR"
done

echo ""
echo "Done. Now update index.html:"
echo "  glyphs: 'http://localhost:8080/fonts/{fontstack}/{range}.pbf'"
echo "  and re-enable the osm-peaks and osm-places layers."
