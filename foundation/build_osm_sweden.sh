#!/usr/bin/env bash
# =============================================================================
# Sweden-wide OSM vector tiles → sweden.pmtiles (what the mtb-editor viewer's
# OSM layers load). Same extraction + tippecanoe flags as build_pipeline.sh
# Steps 1–2, but for the whole country and into separate outputs, so the
# Dalarna osm_layers/ (used by compute_rock.py's man-made mask) stay untouched.
#
# Everything runs on local disk: tippecanoe writing its output on /mnt/g took
# 3.5 h for a third of the job (SQLite-style small writes over the WSL mount);
# locally the tile step is ~26 min. The finished archive is copied to G: once.
# Extraction (extract_osm.py) is the slow part — hours; keep the PC awake.
#
# Usage:  bash build_osm_sweden.sh [--skip-extract]
# =============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PBF="${OSM_PBF:-$DIR/osm/sweden-latest.osm.pbf}"
LAYERS=~/lidar-output/osm_layers_sweden
PM=~/lidar-output/sweden.pmtiles
TMP=~/lidar-output/tippecanoe-tmp
BBOX="240000 6100000 930000 7700000"   # all of Sweden, SWEREF99TM
SKIP_EXTRACT=false
[ "${1:-}" = "--skip-extract" ] && SKIP_EXTRACT=true

log() { printf '[%(%H:%M:%S)T] %s\n' -1 "$1"; }
source ~/lidar-env/bin/activate
cd "$DIR"

if [ "$SKIP_EXTRACT" = false ]; then
  log "Extracting OSM ways + nodes"
  python extract_osm.py --bbox $BBOX --pbf "$PBF" --out "$LAYERS"
  log "Extracting OSM polygons"
  python extract_osm_polygons.py --bbox $BBOX --pbf "$PBF" --out "$LAYERS"
fi

LINE=(); for l in roads tracks paths waterways railways powerlines natural_lines; do
  [ -f "$LAYERS/$l.geojson" ] && LINE+=(--no-feature-limit --no-tile-size-limit -L "$l:$LAYERS/$l.geojson"); done
POLY=(); for l in water landuse buildings; do
  [ -f "$LAYERS/$l.geojson" ] && POLY+=(-L "$l:$LAYERS/$l.geojson"); done
PT=(); for l in peaks places; do
  [ -f "$LAYERS/$l.geojson" ] && PT+=(--no-feature-limit --no-tile-size-limit -L "$l:$LAYERS/$l.geojson"); done

log "Packing vector tiles"
mkdir -p "$TMP"
tippecanoe --output="$PM" --force -t "$TMP" --minimum-zoom=6 --maximum-zoom=16 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping --read-parallel \
  --progress-interval=60 "${LINE[@]}" "${POLY[@]}" "${PT[@]}"
rm -rf "$TMP"

log "Copying to G:"
cp "$PM" /mnt/g/lidar-output/sweden.pmtiles
log "Done: $PM ($(du -h "$PM" | cut -f1)) — mtb-editor/tiles/sweden.pmtiles should point at it"
