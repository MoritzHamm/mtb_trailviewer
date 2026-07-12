#!/usr/bin/env bash
# Download OpenMapTiles PBF fonts for self-hosting in the viewer.
# Fonts land in viewer/fonts/{Font Name}/{range}.pbf
set -euo pipefail

FONTS_DIR="/home/mo/lidar/viewer/fonts"
TMP=$(mktemp -d)

echo "Downloading OpenMapTiles fonts zip …"
curl -L \
  "https://github.com/openmaptiles/fonts/releases/download/v2.0/noto-open-sans.zip" \
  -o "$TMP/fonts.zip"

echo "Extracting …"
unzip -q "$TMP/fonts.zip" -d "$TMP/extracted"

echo "Copying needed fonts to $FONTS_DIR/"
mkdir -p "$FONTS_DIR"
for FONT in "Open Sans Regular" "Open Sans Bold"; do
  SRC="$TMP/extracted/$FONT"
  if [ -d "$SRC" ]; then
    rm -rf "$FONTS_DIR/$FONT"
    cp -r "$SRC" "$FONTS_DIR/$FONT"
    COUNT=$(ls "$FONTS_DIR/$FONT"/*.pbf 2>/dev/null | wc -l)
    echo "  $FONT: $COUNT range files"
  else
    echo "  WARNING: $FONT not found in zip — available fonts:"
    ls "$TMP/extracted/" | head -20
  fi
done

rm -rf "$TMP"
echo "Done."
