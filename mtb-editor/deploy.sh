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
#   bash deploy.sh                        # static assets + sweden + contours + rock + nvdb + terrain
#   bash deploy.sh --skip-terrain         # static assets + sweden + contours + rock + nvdb
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
for f in index.html style.css style-config.js tracks.js favicon.ico; do
  rclone copyto "$MTB_DIR/$f" "$DEST/$f" "${RCLONE_COMMON[@]}"
done

log "Uploading coverage.geojson + sweden.pmtiles"
rclone copyto "$MTB_DIR/tiles/coverage.geojson" "$DEST/tiles/coverage.geojson" "${RCLONE_COMMON[@]}"
# OSM vector layers for all of Sweden (foundation/build_osm_sweden.sh, ~5GB) — the
# viewer no longer loads dalarna.pmtiles. Size floor as for the other big archives.
SWEDEN_REAL="$(readlink -f "$MTB_DIR/tiles/sweden.pmtiles")"
if [ "$(stat -c %s "$SWEDEN_REAL")" -lt 1000000000 ]; then
  log "ERROR: $SWEDEN_REAL is under 1GB — not the full-Sweden OSM archive. Not uploading."
  exit 1
fi
rclone copyto "$SWEDEN_REAL" "$DEST/tiles/sweden.pmtiles" "${RCLONE_BIG[@]}"

# Contour lines (foundation/contours.py, full Dalarna, ~1GB). Optional: skipped
# with a note if this checkout doesn't have it, rather than failing the deploy.
if [ -f "$MTB_DIR/tiles/contours.pmtiles" ]; then
  CONTOURS_REAL="$(readlink -f "$MTB_DIR/tiles/contours.pmtiles")"
  if [ "$(stat -c %s "$CONTOURS_REAL")" -lt 100000000 ]; then
    log "ERROR: $CONTOURS_REAL is under 100MB — not the full-Dalarna contours. Not uploading."
    exit 1
  fi
  log "Uploading contours.pmtiles"
  rclone copyto "$CONTOURS_REAL" "$DEST/tiles/contours.pmtiles" "${RCLONE_BIG[@]}"
else
  log "No tiles/contours.pmtiles here — skipping (the viewer's contour layer will be empty)"
fi

# Rock / cliffs (foundation/compute_rock.py, full Dalarna). Optional like contours;
# the size floor keeps a small local test build from overwriting the real one.
if [ -f "$MTB_DIR/tiles/rock.pmtiles" ]; then
  ROCK_REAL="$(readlink -f "$MTB_DIR/tiles/rock.pmtiles")"
  if [ "$(stat -c %s "$ROCK_REAL")" -lt 200000000 ]; then
    log "ERROR: $ROCK_REAL is under 200MB — not the full-Dalarna rock layer. Not uploading."
    exit 1
  fi
  log "Uploading rock.pmtiles"
  rclone copyto "$ROCK_REAL" "$DEST/tiles/rock.pmtiles" "${RCLONE_BIG[@]}"
else
  log "No tiles/rock.pmtiles here — skipping (the Rock / cliffs background will be empty)"
fi

# Trafikverket NVDB roads (foundation/extract_nvdb.py, ~35MB for Dalarna). Optional.
if [ -f "$MTB_DIR/tiles/nvdb.pmtiles" ]; then
  log "Uploading nvdb.pmtiles"
  rclone copyto "$(readlink -f "$MTB_DIR/tiles/nvdb.pmtiles")" "$DEST/tiles/nvdb.pmtiles" "${RCLONE_COMMON[@]}" --progress -v
else
  log "No tiles/nvdb.pmtiles here — skipping (the NVDB roads layer will be empty)"
fi

if [ "$SKIP_TERRAIN" = false ]; then
  log "Uploading terrain.pmtiles (large, background-worthy)"
  TERRAIN_REAL="$(readlink -f "$MTB_DIR/tiles/terrain.pmtiles")"
  # Refuse to overwrite the real (~53GB) archive on R2 with a local placeholder —
  # a worktree can have a tiny stand-in terrain.pmtiles just so serve.py doesn't 404.
  TERRAIN_BYTES="$(stat -c %s "$TERRAIN_REAL")"
  if [ "$TERRAIN_BYTES" -lt 1000000000 ]; then
    log "ERROR: $TERRAIN_REAL is only $TERRAIN_BYTES bytes — looks like a placeholder, not the real archive. Use --skip-terrain."
    exit 1
  fi
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
