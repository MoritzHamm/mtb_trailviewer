#!/usr/bin/env bash
# ===========================================================================
# Terrain map build pipeline
#
# Steps:
#   1. Extract OSM nodes + ways  (extract_osm.py)
#   2. Extract OSM polygons      (extract_osm_polygons.py)
#   3. Generate vector PMTiles   (tippecanoe)
#   4. Copy tiles to viewer
#
# Future hooks (not yet implemented):
#   5. Cliff detection from LiDAR → natural_lines layer
#   6. Gradient coloring along paths
#
# Usage:
#   bash build_pipeline.sh [--bbox "minx miny maxx maxy"] [--skip-osm] [--skip-tiles]
# ===========================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LIDAR_DIR="/home/mo/lidar"
PBF="/home/mo/lidar/osm/sweden-latest.osm.pbf"
WORK="/home/mo/lidar-output"
LAYERS="$WORK/osm_layers"
PMTILES="$WORK/dalarna.pmtiles"
VIEWER="$LIDAR_DIR/viewer/tiles"

# Dalarna LiDAR extent in SWEREF99TM (matches the merged VRT)
BBOX="342500 6630000 600000 6900000"

SKIP_OSM=false
SKIP_TILES=false

for arg in "$@"; do
  case $arg in
    --skip-osm)   SKIP_OSM=true ;;
    --skip-tiles) SKIP_TILES=true ;;
    --bbox)       shift; BBOX="$1" ;;
  esac
done

source ~/lidar-env/bin/activate

# ---------------------------------------------------------------------------
# Step 1 + 2: OSM extraction
# ---------------------------------------------------------------------------
if [ "$SKIP_OSM" = false ]; then
  echo "========================================"
  echo "Step 1: Extracting OSM nodes + ways"
  echo "========================================"
  python "$LIDAR_DIR/extract_osm.py" \
    --bbox $BBOX \
    --pbf  "$PBF" \
    --out  "$LAYERS"

  echo ""
  echo "========================================"
  echo "Step 2: Extracting OSM polygons"
  echo "========================================"
  python "$LIDAR_DIR/extract_osm_polygons.py" \
    --bbox $BBOX \
    --pbf  "$PBF" \
    --out  "$LAYERS"
else
  echo "Skipping OSM extraction (--skip-osm)"
fi

# ---------------------------------------------------------------------------
# Step 3: tippecanoe → PMTiles
# ---------------------------------------------------------------------------
if [ "$SKIP_TILES" = false ]; then
  echo ""
  echo "========================================"
  echo "Step 3: Building PMTiles with tippecanoe"
  echo "========================================"

  # Collect -L args for each layer that exists
  LAYER_ARGS=()
  for layer in roads tracks paths waterways railways powerlines natural_lines \
               water landuse buildings peaks places; do
    f="$LAYERS/${layer}.geojson"
    if [ -f "$f" ]; then
      LAYER_ARGS+=("-L" "${layer}:${f}")
    else
      echo "  Skipping missing layer: $layer"
    fi
  done

  tippecanoe \
    --output="$PMTILES" \
    --force \
    --minimum-zoom=6 \
    --maximum-zoom=16 \
    --drop-densest-as-needed \
    --extend-zooms-if-still-dropping \
    --read-parallel \
    "${LAYER_ARGS[@]}"

  echo "PMTiles written: $PMTILES"
else
  echo "Skipping tile build (--skip-tiles)"
fi

# ---------------------------------------------------------------------------
# Step 4: Copy to viewer
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Step 4: Copying to viewer"
echo "========================================"
mkdir -p "$VIEWER"
cp "$PMTILES" "$VIEWER/dalarna.pmtiles"
echo "Copied → $VIEWER/dalarna.pmtiles"

echo ""
echo "Pipeline complete. Reload the viewer."
