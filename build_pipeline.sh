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
#   1. OSM extraction        → $WORK/osm_layers/
#   2. Vector PMTiles        → $WORK/dalarna.pmtiles
#   3. RGBA overlay tiles    → $WORK/overlay-tiles/
#   4. Overlay PMTiles       → $WORK/overlay.pmtiles
#   5. Terrain RGB tiles     → $WORK/terrain-tiles/  → $WORK/terrain.pmtiles
#   6. Copy tiles to viewer
#
# Usage:
#   bash build_pipeline.sh [--skip-osm] [--skip-overlay] [--skip-terrain]
#   bash build_pipeline.sh --skip-osm                      # overlay + terrain only
#   bash build_pipeline.sh --skip-terrain --skip-overlay   # OSM/vectors only
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
# Flags (parsed before paths so --work= and --bbox= take effect)
# -----------------------------------------------------------------------------
SKIP_OSM=false
SKIP_OVERLAY=false
SKIP_TERRAIN=false
MAX_ZOOM=17
BBOX="342500 6630000 600000 6900000"   # full Dalarna
WORK="$HOME/lidar-output"
DTM_OVERRIDE=""   # override DTM source (single tile instead of merged VRT)
CHM_OVERRIDE=""   # override CHM source
WETNESS_OVERRIDE="" # override wetness source

for arg in "$@"; do
  case $arg in
    --skip-osm)      SKIP_OSM=true ;;
    --skip-overlay)  SKIP_OVERLAY=true ;;
    --skip-terrain)  SKIP_TERRAIN=true ;;
    --max-zoom=*)    MAX_ZOOM="${arg#--max-zoom=}" ;;
    --bbox=*)        BBOX="${arg#--bbox=}" ;;
    --work=*)        WORK="${arg#--work=}" ;;
    --dtm=*)         DTM_OVERRIDE="${arg#--dtm=}" ;;
    --chm=*)         CHM_OVERRIDE="${arg#--chm=}" ;;
    --wetness=*)     WETNESS_OVERRIDE="${arg#--wetness=}" ;;
  esac
done

[ -n "$DTM_OVERRIDE"     ] && DTM_VRT="$DTM_OVERRIDE"
[ -n "$CHM_OVERRIDE"     ] && CHM_VRT="$CHM_OVERRIDE"
[ -n "$WETNESS_OVERRIDE" ] && WETNESS="$WETNESS_OVERRIDE"

# -----------------------------------------------------------------------------
# All outputs go here (overridable with --work=)
# -----------------------------------------------------------------------------
mkdir -p "$WORK"

OSM_LAYERS="$WORK/osm_layers"
VEC_PMTILES="$WORK/dalarna.pmtiles"
OVERLAY_TILES="$WORK/overlay-tiles"
OVERLAY_PMTILES="$WORK/overlay.pmtiles"
TERRAIN_TILES="$WORK/terrain-tiles"
TERRAIN_PMTILES="$WORK/terrain.pmtiles"

LIDAR_DIR="$(cd "$(dirname "$0")" && pwd)"
VIEWER="$LIDAR_DIR/viewer/tiles"

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

  # Line layers: never drop features — trails are the whole point
  LINE_ARGS=()
  for layer in roads tracks paths waterways railways powerlines natural_lines; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && LINE_ARGS+=(
      "--no-feature-limit" "--no-tile-size-limit" "-L" "${layer}:${f}") \
                || echo "  Skipping missing layer: $layer"
  done

  # Polygon layers: allow dropping in dense areas (buildings/landuse bloat tiles)
  POLY_ARGS=()
  for layer in water landuse buildings; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && POLY_ARGS+=("-L" "${layer}:${f}") \
                || echo "  Skipping missing layer: $layer"
  done

  # Point layers: never drop
  POINT_ARGS=()
  for layer in peaks places; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && POINT_ARGS+=(
      "--no-feature-limit" "--no-tile-size-limit" "-L" "${layer}:${f}") \
                || echo "  Skipping missing layer: $layer"
  done

  tippecanoe \
    --output="$VEC_PMTILES" --force \
    --minimum-zoom=6 --maximum-zoom=16 \
    --drop-densest-as-needed --extend-zooms-if-still-dropping \
    --read-parallel \
    "${LINE_ARGS[@]}" "${POLY_ARGS[@]}" "${POINT_ARGS[@]}"

  echo "Written: $VEC_PMTILES"
else
  echo "Skipping vector PMTiles (--skip-osm)"
fi

# -----------------------------------------------------------------------------
# Step 3 + 4: Overlay tiles
# -----------------------------------------------------------------------------
if [ "$SKIP_OVERLAY" = false ]; then
  echo ""
  echo "========================================"
  echo "Step 3: Generating RGBA overlay tiles"
  echo "========================================"

  OVERLAY_ARGS=(--out "$OVERLAY_TILES" --bbox $BBOX)
  [ -n "$CHM_VRT"  ] && [ -f "$CHM_VRT"  ] && OVERLAY_ARGS+=(--chm "$CHM_VRT")
  [ -n "$WETNESS"  ] && [ -f "$WETNESS"  ] && OVERLAY_ARGS+=(--wetness "$WETNESS")

  python "$LIDAR_DIR/generate_overlay_tiles.py" "${OVERLAY_ARGS[@]}" --zoom 12 "$MAX_ZOOM"

  echo ""
  echo "========================================"
  echo "Step 4: Packing overlay tiles → PMTiles"
  echo "========================================"
  python "$LIDAR_DIR/pack_tiles.py" "$OVERLAY_TILES" "$OVERLAY_PMTILES" --name overlay
else
  echo "Skipping overlay tiles (--skip-overlay)"
fi

# -----------------------------------------------------------------------------
# Step 5: Terrain RGB tiles
# -----------------------------------------------------------------------------
if [ "$SKIP_TERRAIN" = false ]; then
  echo ""
  echo "========================================"
  echo "Step 5: Generating terrain RGB tiles"
  echo "========================================"
  if [ ! -f "$DTM_VRT" ]; then
    echo "ERROR: DTM not found at $DTM_VRT"
    exit 1
  fi
  python "$LIDAR_DIR/generate_elevation_tiles.py" \
    "$DTM_VRT" "$TERRAIN_TILES" --zoom 12 "$MAX_ZOOM" --bbox $BBOX

  echo ""
  echo "========================================"
  echo "Step 5b: Packing terrain tiles → PMTiles"
  echo "========================================"
  python "$LIDAR_DIR/pack_tiles.py" \
    "$TERRAIN_TILES" "$TERRAIN_PMTILES" --name terrain
else
  echo "Skipping terrain tiles (--skip-terrain)"
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
copy_if_exists "$TERRAIN_PMTILES" "$VIEWER/terrain.pmtiles"

echo ""
echo "Pipeline complete."
