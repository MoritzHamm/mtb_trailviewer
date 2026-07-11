#!/usr/bin/env bash
# =============================================================================
# Re-download the Geofabrik Sweden PBF snapshot and rebuild only the OSM/
# vector layer (dalarna.pmtiles) — leaves DTM/CHM/overlay/terrain untouched.
#
# Geofabrik regenerates their region extracts roughly once every 24h from the
# OSM planet diffs, so your edits land here on that cadence regardless of how
# often this script runs — it's the snapshot that's the bottleneck, not this.
#
# Not scheduled (yet) — run manually whenever you want a refresh:
#   bash refresh_osm.sh
# =============================================================================
set -euo pipefail

log() { printf '[%(%H:%M:%S)T] %s\n' -1 "$1"; }

LIDAR_DIR="$(cd "$(dirname "$0")" && pwd)"
PBF_URL="https://download.geofabrik.de/europe/sweden-latest.osm.pbf"
PBF_PATH="$LIDAR_DIR/osm/sweden-latest.osm.pbf"   # matches build_pipeline.sh's OSM_PBF
PBF_TMP="$PBF_PATH.tmp"

log "Downloading $PBF_URL"
curl -fSL --progress-bar -o "$PBF_TMP" "$PBF_URL"
mv "$PBF_TMP" "$PBF_PATH"
log "Saved: $PBF_PATH ($(du -h "$PBF_PATH" | cut -f1))"

log "Rebuilding OSM/vector layer only"
bash "$LIDAR_DIR/build_pipeline.sh" --skip-overlay --skip-terrain

log "Done — dalarna.pmtiles refreshed in viewer/tiles/"
