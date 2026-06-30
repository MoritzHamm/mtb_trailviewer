#!/usr/bin/env bash
# =============================================================================
# Terrain map build pipeline
#
# Sources (read-only, may live on slow drives):
#   DTM_VRT    — merged DTM virtual raster from batch_rasterize output
#   CHM_VRT    — merged CHM (leave empty until batch CHM is ready)
#   WETNESS    — SLU Markfuktighetskarta full-Sweden GeoTIFF
#   OSM_PBF    — sweden-latest.osm.pbf
#
# All intermediate and output files go to WORK (~/lidar-output).
# The viewer/tiles directory is populated at the end.
#
# Steps:
#   1. OSM extraction       → $WORK/osm_layers/
#   2. Vector PMTiles       → $WORK/dalarna.pmtiles
#   3. LRM from DTM         → $WORK/dalarna_lrm.tif
#   4. RGBA overlay tiles   → $WORK/overlay-tiles/
#   5. Overlay PMTiles      → $WORK/overlay.pmtiles
#   6. Copy tiles to viewer
#
# Usage:
#   bash build_pipeline.sh [--skip-osm] [--skip-lrm] [--skip-overlay]
#   bash build_pipeline.sh --skip-osm              # overlay only
#   bash build_pipeline.sh --skip-lrm --skip-overlay  # OSM/vectors only
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Sources  (only place that references external drives)
# -----------------------------------------------------------------------------
DTM_VRT="$HOME/lidar-output/dtm/merged_dtm.vrt"
CHM_VRT="$HOME/lidar-output/dtm/merged_chm.vrt"
WETNESS="/mnt/g/SLU/SLUMarkfuktighetskarta/SLUMarkfuktighetskarta.tif"
OSM_PBF="/home/mo/lidar/osm/sweden-latest.osm.pbf"

# -----------------------------------------------------------------------------
# All outputs go here
# -----------------------------------------------------------------------------
WORK="$HOME/lidar-output"
mkdir -p "$WORK"

LRM="$WORK/dalarna_lrm.tif"
OSM_LAYERS="$WORK/osm_layers"
VEC_PMTILES="$WORK/dalarna.pmtiles"
OVERLAY_TILES="$WORK/overlay-tiles"
OVERLAY_PMTILES="$WORK/overlay.pmtiles"

LIDAR_DIR="$(cd "$(dirname "$0")" && pwd)"
VIEWER="$LIDAR_DIR/viewer/tiles"

# Dalarna LiDAR extent in SWEREF99TM
BBOX="342500 6630000 600000 6900000"

# -----------------------------------------------------------------------------
# Flags
# -----------------------------------------------------------------------------
SKIP_OSM=false
SKIP_LRM=false
SKIP_OVERLAY=false
MAX_ZOOM=14

for arg in "$@"; do
  case $arg in
    --skip-osm)     SKIP_OSM=true ;;
    --skip-lrm)     SKIP_LRM=true ;;
    --skip-overlay) SKIP_OVERLAY=true ;;
    --max-zoom=*)   MAX_ZOOM="${arg#--max-zoom=}" ;;
  esac
done

source ~/lidar-env/bin/activate

# -----------------------------------------------------------------------------
# Step 1: OSM extraction
# -----------------------------------------------------------------------------
if [ "$SKIP_OSM" = false ]; then
  echo "========================================"
  echo "Step 1a: Extracting OSM ways + nodes"
  echo "========================================"
  python "$LIDAR_DIR/extract_osm.py" \
    --bbox $BBOX --pbf "$OSM_PBF" --out "$OSM_LAYERS"

  echo ""
  echo "========================================"
  echo "Step 1b: Extracting OSM polygons"
  echo "========================================"
  python "$LIDAR_DIR/extract_osm_polygons.py" \
    --bbox $BBOX --pbf "$OSM_PBF" --out "$OSM_LAYERS"
else
  echo "Skipping OSM extraction (--skip-osm)"
fi

# -----------------------------------------------------------------------------
# Step 2: Vector PMTiles
# -----------------------------------------------------------------------------
if [ "$SKIP_OSM" = false ]; then
  echo ""
  echo "========================================"
  echo "Step 2: Building vector PMTiles"
  echo "========================================"

  LAYER_ARGS=()
  for layer in roads tracks paths waterways railways powerlines natural_lines \
               water landuse buildings; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && LAYER_ARGS+=("-L" "${layer}:${f}") \
                || echo "  Skipping missing layer: $layer"
  done

  POINT_ARGS=()
  for layer in peaks places; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && POINT_ARGS+=(
      "--no-feature-limit" "--no-tile-size-limit" "-L" "${layer}:${f}")
  done

  tippecanoe \
    --output="$VEC_PMTILES" --force \
    --minimum-zoom=6 --maximum-zoom=16 \
    --drop-densest-as-needed --extend-zooms-if-still-dropping \
    --read-parallel \
    "${LAYER_ARGS[@]}" "${POINT_ARGS[@]}"

  echo "Written: $VEC_PMTILES"
else
  echo "Skipping vector PMTiles (--skip-osm)"
fi

# -----------------------------------------------------------------------------
# Step 3: LRM
# -----------------------------------------------------------------------------
if [ "$SKIP_LRM" = false ]; then
  echo ""
  echo "========================================"
  echo "Step 3: Computing LRM from DTM"
  echo "========================================"
  if [ ! -f "$DTM_VRT" ]; then
    echo "ERROR: DTM not found at $DTM_VRT"
    exit 1
  fi
  python "$LIDAR_DIR/compute_lrm.py" "$DTM_VRT" "$LRM"
else
  echo "Skipping LRM (--skip-lrm)"
fi

# -----------------------------------------------------------------------------
# Step 4 + 5: Overlay tiles
# -----------------------------------------------------------------------------
if [ "$SKIP_OVERLAY" = false ]; then
  echo ""
  echo "========================================"
  echo "Step 4: Generating RGBA overlay tiles"
  echo "========================================"

  if [ ! -f "$LRM" ]; then
    echo "ERROR: LRM not found at $LRM — run without --skip-lrm first"
    exit 1
  fi

  OVERLAY_ARGS=(--lrm "$LRM" --out "$OVERLAY_TILES")
  [ -n "$CHM_VRT"  ] && [ -f "$CHM_VRT"  ] && OVERLAY_ARGS+=(--chm "$CHM_VRT")
  [ -n "$WETNESS"  ] && [ -f "$WETNESS"  ] && OVERLAY_ARGS+=(--wetness "$WETNESS")

  python "$LIDAR_DIR/generate_overlay_tiles.py" "${OVERLAY_ARGS[@]}" --zoom 12 "$MAX_ZOOM"

  echo ""
  echo "========================================"
  echo "Step 5: Packing overlay tiles → PMTiles"
  echo "========================================"
  python "$LIDAR_DIR/pack_tiles.py" "$OVERLAY_TILES" "$OVERLAY_PMTILES" --name overlay
else
  echo "Skipping overlay tiles (--skip-overlay)"
fi

# -----------------------------------------------------------------------------
# Step 6: Copy to viewer
# -----------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Step 6: Copying to viewer"
echo "========================================"
mkdir -p "$VIEWER"

copy_if_exists() {
  [ -f "$1" ] && cp "$1" "$2" && echo "  $2" || echo "  SKIP (not built): $1"
}

copy_if_exists "$VEC_PMTILES"     "$VIEWER/dalarna.pmtiles"
copy_if_exists "$OVERLAY_PMTILES" "$VIEWER/overlay.pmtiles"

echo ""
echo "Pipeline complete."
