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
# Intermediate/output files are split across two work dirs:
#   WORK_FAST (~/lidar-output)       — raw z/x/y.png tile pyramids. Millions of
#                                       small files; generating and packing them
#                                       needs fast local disk or it turns into a
#                                       multi-hour crawl on a networked mount.
#   WORK_SLOW (/mnt/g/lidar-output)  — everything else (OSM layers, finished
#                                       .pmtiles). Few, larger files — a slower
#                                       mount is fine, and it keeps this off the
#                                       small local disk.
# MTB_EDITOR_DIR (../mtb-editor, a sibling since the foundation/mtb-editor/
# game-editor reorg) gets its tiles/ directory populated at the end.
#
# Steps:
#   1. OSM extraction        → $WORK_SLOW/osm_layers/
#   2. Vector PMTiles        → $WORK_SLOW/dalarna.pmtiles
#   3. RGBA overlay tiles    → $WORK_FAST/overlay-tiles/
#   4. Overlay PMTiles       → $WORK_SLOW/overlay.pmtiles
#   5. Terrain RGB tiles     → $WORK_FAST/terrain-tiles/  → $WORK_SLOW/terrain.pmtiles
#   6. Copy tiles to mtb-editor/tiles/
#
# Usage:
#   bash build_pipeline.sh [--skip-osm] [--skip-overlay] [--skip-terrain]
#   bash build_pipeline.sh --skip-osm                      # overlay + terrain only
#   bash build_pipeline.sh --skip-terrain --skip-overlay   # OSM/vectors only
#   bash build_pipeline.sh --work-fast=/path --work-slow=/path --mtb-editor-dir=/path
# =============================================================================
set -euo pipefail

log() { printf '[%(%H:%M:%S)T] %s\n' -1 "$1"; }

# -----------------------------------------------------------------------------
# Sources  (only place that references external drives)
# -----------------------------------------------------------------------------
DTM_VRT="$HOME/lidar-output/dtm/merged_dtm.vrt"
CHM_VRT="$HOME/lidar-output/dtm/merged_chm.vrt"
WETNESS="/mnt/g/SLU/SLUMarkfuktighetskarta/SLUMarkfuktighetskarta.tif"
LIDAR_DIR="$(cd "$(dirname "$0")" && pwd)"
OSM_PBF="$LIDAR_DIR/osm/sweden-latest.osm.pbf"

# -----------------------------------------------------------------------------
# Flags (parsed before paths so --work= and --bbox= take effect)
# -----------------------------------------------------------------------------
SKIP_OSM=false
SKIP_OVERLAY=false
SKIP_TERRAIN=false
MAX_ZOOM=17
BBOX="342500 6630000 600000 6900000"   # full Dalarna
WORK_FAST="$HOME/lidar-output"         # tile pyramids — needs fast local disk
WORK_SLOW="/mnt/g/lidar-output"        # everything else — fine on a slower mount
MTB_EDITOR_DIR="$LIDAR_DIR/../mtb-editor"   # sibling dir since the reorg (was a child: viewer/)
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
    --work-fast=*)   WORK_FAST="${arg#--work-fast=}" ;;
    --work-slow=*)   WORK_SLOW="${arg#--work-slow=}" ;;
    --mtb-editor-dir=*) MTB_EDITOR_DIR="${arg#--mtb-editor-dir=}" ;;
    --dtm=*)         DTM_OVERRIDE="${arg#--dtm=}" ;;
    --chm=*)         CHM_OVERRIDE="${arg#--chm=}" ;;
    --wetness=*)     WETNESS_OVERRIDE="${arg#--wetness=}" ;;
  esac
done

[ -n "$DTM_OVERRIDE"     ] && DTM_VRT="$DTM_OVERRIDE"
[ -n "$CHM_OVERRIDE"     ] && CHM_VRT="$CHM_OVERRIDE"
[ -n "$WETNESS_OVERRIDE" ] && WETNESS="$WETNESS_OVERRIDE"

# -----------------------------------------------------------------------------
# Outputs go to WORK_FAST (tile pyramids) or WORK_SLOW (everything else),
# overridable with --work-fast= / --work-slow=
# -----------------------------------------------------------------------------
mkdir -p "$WORK_FAST" "$WORK_SLOW"

OSM_LAYERS="$WORK_SLOW/osm_layers"
VEC_PMTILES="$WORK_SLOW/dalarna.pmtiles"
OVERLAY_TILES="$WORK_FAST/overlay-tiles"
OVERLAY_PMTILES="$WORK_SLOW/overlay.pmtiles"
TERRAIN_TILES="$WORK_FAST/terrain-tiles"
TERRAIN_PMTILES="$WORK_SLOW/terrain.pmtiles"

VIEWER="$MTB_EDITOR_DIR/tiles"

source ~/lidar-env/bin/activate

# -----------------------------------------------------------------------------
# Step 1: OSM extraction
# -----------------------------------------------------------------------------
if [ "$SKIP_OSM" = false ]; then
  log "Step 1a: Extracting OSM ways + nodes"
  python "$LIDAR_DIR/extract_osm.py" \
    --bbox $BBOX --pbf "$OSM_PBF" --out "$OSM_LAYERS"

  log "Step 1b: Extracting OSM polygons"
  python "$LIDAR_DIR/extract_osm_polygons.py" \
    --bbox $BBOX --pbf "$OSM_PBF" --out "$OSM_LAYERS"
else
  log "Skipping OSM extraction (--skip-osm)"
fi

# -----------------------------------------------------------------------------
# Step 2: Vector PMTiles
# -----------------------------------------------------------------------------
if [ "$SKIP_OSM" = false ]; then
  log "Step 2: Building vector PMTiles"

  # Line layers: never drop features — trails are the whole point
  LINE_ARGS=()
  for layer in roads tracks paths waterways railways powerlines natural_lines; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && LINE_ARGS+=(
      "--no-feature-limit" "--no-tile-size-limit" "-L" "${layer}:${f}") \
                || log "  Skipping missing layer: $layer"
  done

  # Polygon layers: allow dropping in dense areas (buildings/landuse bloat tiles)
  POLY_ARGS=()
  for layer in water landuse buildings; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && POLY_ARGS+=("-L" "${layer}:${f}") \
                || log "  Skipping missing layer: $layer"
  done

  # Point layers: never drop
  POINT_ARGS=()
  for layer in peaks places; do
    f="$OSM_LAYERS/${layer}.geojson"
    [ -f "$f" ] && POINT_ARGS+=(
      "--no-feature-limit" "--no-tile-size-limit" "-L" "${layer}:${f}") \
                || log "  Skipping missing layer: $layer"
  done

  tippecanoe \
    --output="$VEC_PMTILES" --force \
    --minimum-zoom=6 --maximum-zoom=16 \
    --drop-densest-as-needed --extend-zooms-if-still-dropping \
    --read-parallel \
    "${LINE_ARGS[@]}" "${POLY_ARGS[@]}" "${POINT_ARGS[@]}"

  log "Written: $VEC_PMTILES"
else
  log "Skipping vector PMTiles (--skip-osm)"
fi

# -----------------------------------------------------------------------------
# Step 3 + 4: Overlay tiles
# -----------------------------------------------------------------------------
if [ "$SKIP_OVERLAY" = false ]; then
  log "Step 3: Generating RGBA overlay tiles"

  OVERLAY_ARGS=(--out "$OVERLAY_TILES" --bbox $BBOX)
  [ -n "$CHM_VRT"  ] && [ -f "$CHM_VRT"  ] && OVERLAY_ARGS+=(--chm "$CHM_VRT")
  [ -n "$WETNESS"  ] && [ -f "$WETNESS"  ] && OVERLAY_ARGS+=(--wetness "$WETNESS")

  python "$LIDAR_DIR/generate_overlay_tiles.py" "${OVERLAY_ARGS[@]}" --zoom 12 "$MAX_ZOOM"

  log "Step 4: Packing overlay tiles → PMTiles"
  python "$LIDAR_DIR/pack_tiles.py" "$OVERLAY_TILES" "$OVERLAY_PMTILES" --name overlay
else
  log "Skipping overlay tiles (--skip-overlay)"
fi

# -----------------------------------------------------------------------------
# Step 5: Terrain RGB tiles
# -----------------------------------------------------------------------------
if [ "$SKIP_TERRAIN" = false ]; then
  log "Step 5: Generating terrain RGB tiles"
  if [ ! -f "$DTM_VRT" ]; then
    log "ERROR: DTM not found at $DTM_VRT"
    exit 1
  fi
  python "$LIDAR_DIR/generate_elevation_tiles.py" \
    "$DTM_VRT" "$TERRAIN_TILES" --zoom 12 "$MAX_ZOOM" --bbox $BBOX

  log "Step 5b: Packing terrain tiles → PMTiles"
  python "$LIDAR_DIR/pack_tiles.py" \
    "$TERRAIN_TILES" "$TERRAIN_PMTILES" --name terrain
else
  log "Skipping terrain tiles (--skip-terrain)"
fi

# -----------------------------------------------------------------------------
# Step 6: Copy to mtb-editor/tiles/
# -----------------------------------------------------------------------------
log "Step 6: Copying to mtb-editor"
mkdir -p "$VIEWER"

copy_if_exists() {
  [ -f "$1" ] && cp "$1" "$2" && log "  $2" || log "  SKIP (not built): $1"
}

# Overlay/terrain pmtiles are hosted from WORK_SLOW (e.g. R2/Cloudflare in
# production) rather than bundled with the app — symlink instead of copying,
# so the viewer can still read them locally without duplicating hundreds of GB
# onto the local disk.
link_if_exists() {
  [ -f "$1" ] && ln -sf "$1" "$2" && log "  $2 -> $1" || log "  SKIP (not built): $1"
}

copy_if_exists "$VEC_PMTILES"     "$VIEWER/dalarna.pmtiles"
link_if_exists "$OVERLAY_PMTILES" "$VIEWER/overlay.pmtiles"
link_if_exists "$TERRAIN_PMTILES" "$VIEWER/terrain.pmtiles"
copy_if_exists "$TERRAIN_TILES/coverage.geojson" "$VIEWER/coverage.geojson"

log "Pipeline complete."
