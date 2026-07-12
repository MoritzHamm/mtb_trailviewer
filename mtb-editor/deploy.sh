#!/usr/bin/env bash
# =============================================================================
# Deploy mtb-editor to Cloudflare R2.
#
# Uploads static assets first (small, synced every run), then the large
# PMTiles archives. terrain.pmtiles/overlay.pmtiles are read via their real
# path on G: (readlink -f), not the tiles/ symlink — rclone doesn't follow
# symlinks by default.
#
# Requires an rclone remote already configured against R2's S3-compatible
# endpoint (rclone config, type s3, provider Cloudflare, acl private) and a
# bucket-scoped R2 API token.
#
# Usage:
#   bash deploy.sh                        # static assets + dalarna + terrain
#   bash deploy.sh --skip-terrain         # static assets + dalarna only
#   bash deploy.sh --with-overlay         # also upload overlay.pmtiles
#   bash deploy.sh --remote=X --bucket=Y  # override rclone remote/bucket name
#
# overlay.pmtiles is skipped by default — that data is retired pending a
# rework (restrict to terrain's real-coverage footprint, move wetness off the
# alpha channel, see foundation/generate_overlay_tiles.py). Not worth
# uploading the current 255GB build before it's replaced.
# =============================================================================
set -euo pipefail

MTB_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE="Dalarna-MTB"
BUCKET="dalarna-mtb"
SKIP_TERRAIN=false
SKIP_OVERLAY=true

for arg in "$@"; do
  case $arg in
    --skip-terrain)  SKIP_TERRAIN=true ;;
    --skip-overlay)  SKIP_OVERLAY=true ;;
    --with-overlay)  SKIP_OVERLAY=false ;;
    --remote=*)      REMOTE="${arg#--remote=}" ;;
    --bucket=*)      BUCKET="${arg#--bucket=}" ;;
  esac
done

DEST="$REMOTE:$BUCKET"
RCLONE_COMMON=(--s3-no-check-bucket --checksum)
# R2's multipart cap is 10,000 parts; the default 5MiB chunk would blow that
# on a 255GB file (~51,000 parts). 256M keeps even the largest file well
# under the limit.
RCLONE_BIG=("${RCLONE_COMMON[@]}" --s3-chunk-size=256M --s3-upload-concurrency=8 \
            --retries=10 --low-level-retries=20 --retries-sleep=10s --progress -v)

log() { printf '[%(%H:%M:%S)T] %s\n' -1 "$1"; }

log "Syncing static assets → $DEST"
rclone sync "$MTB_DIR/fonts/" "$DEST/fonts/" "${RCLONE_COMMON[@]}"
for f in index.html style.css style-config.js favicon.ico; do
  rclone copyto "$MTB_DIR/$f" "$DEST/$f" "${RCLONE_COMMON[@]}"
done

log "Uploading coverage.geojson + dalarna.pmtiles"
rclone copyto "$MTB_DIR/tiles/coverage.geojson" "$DEST/tiles/coverage.geojson" "${RCLONE_COMMON[@]}"
rclone copyto "$MTB_DIR/tiles/dalarna.pmtiles"  "$DEST/tiles/dalarna.pmtiles"  "${RCLONE_COMMON[@]}" --progress -v

if [ "$SKIP_TERRAIN" = false ]; then
  log "Uploading terrain.pmtiles (large, background-worthy)"
  TERRAIN_REAL="$(readlink -f "$MTB_DIR/tiles/terrain.pmtiles")"
  rclone copyto "$TERRAIN_REAL" "$DEST/tiles/terrain.pmtiles" "${RCLONE_BIG[@]}"
else
  log "Skipping terrain.pmtiles (--skip-terrain)"
fi

if [ "$SKIP_OVERLAY" = false ]; then
  log "Uploading overlay.pmtiles (large, background-worthy)"
  OVERLAY_REAL="$(readlink -f "$MTB_DIR/tiles/overlay.pmtiles")"
  rclone copyto "$OVERLAY_REAL" "$DEST/tiles/overlay.pmtiles" "${RCLONE_BIG[@]}"
else
  log "Skipping overlay.pmtiles (retired for now — pass --with-overlay to force)"
fi

log "Done."
