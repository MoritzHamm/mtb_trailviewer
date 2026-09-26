#!/usr/bin/env bash
# =============================================================================
# Deploy mtb-editor to Cloudflare R2.
#
# Uploads static assets first (small, synced every run), then the large
# PMTiles archives. terrain.pmtiles/vegheight.pmtiles/wetness.pmtiles are read
# via their real path on G: (readlink -f), not the tiles/ symlink — rclone
# doesn't follow symlinks by default.
#
# Requires an rclone remote already configured against R2's S3-compatible
# endpoint (rclone config, type s3, provider Cloudflare, acl private) and a
# bucket-scoped R2 API token.
#
# Usage:
#   bash deploy.sh                        # static assets + dalarna + terrain
#   bash deploy.sh --skip-terrain         # static assets + dalarna only
#   bash deploy.sh --with-overlay         # also upload vegheight/wetness.pmtiles
#   bash deploy.sh --remote=X --bucket=Y  # override rclone remote/bucket name
#
# vegheight.pmtiles/wetness.pmtiles are skipped by default until the reworked
# build (see foundation/CLAUDE.md's "Overlay status") has actually been run
# for full Dalarna and verified in a browser — only the Lövberget sample tile
# has been tested so far. Once verified, expected total is ~6-7GB combined
# (down from the old single 255GB overlay.pmtiles), so --with-overlay should
# become the default rather than an opt-in.
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
  log "Uploading vegheight.pmtiles + wetness.pmtiles"
  VEGHEIGHT_REAL="$(readlink -f "$MTB_DIR/tiles/vegheight.pmtiles")"
  WETNESS_REAL="$(readlink -f "$MTB_DIR/tiles/wetness.pmtiles")"
  rclone copyto "$VEGHEIGHT_REAL" "$DEST/tiles/vegheight.pmtiles" "${RCLONE_BIG[@]}"
  rclone copyto "$WETNESS_REAL"   "$DEST/tiles/wetness.pmtiles"   "${RCLONE_BIG[@]}"
else
  log "Skipping vegheight/wetness.pmtiles (pass --with-overlay to force)"
fi

log "Done."
