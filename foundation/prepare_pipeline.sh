#!/usr/bin/env bash
# =============================================================================
# Prepare pipeline: LAZ → per-tile DTM + CHM GeoTIFFs + merged VRTs
#
# Reads source LAZ files from the mounted drive (read-only).
# All output goes to ~/lidar-output/dtm (local, fast).
#
# Safe to re-run: tiles with both _dtm.tif and _chm.tif already present
# are skipped automatically.
#
# Usage:
#   bash prepare_pipeline.sh [--workers N] [--pattern "*.laz"]
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Sources (read-only)
# -----------------------------------------------------------------------------
LAZ_DIR="/mnt/g/Download"

# -----------------------------------------------------------------------------
# Output (local only)
# -----------------------------------------------------------------------------
OUT_DIR="$HOME/lidar-output/dtm"

# -----------------------------------------------------------------------------
# Defaults
# ~750 MB–1 GB peak RAM per worker (LAZ arrays + grids).
# With 32 GB RAM, 6 workers is safe; bump with --workers if you have headroom.
# -----------------------------------------------------------------------------
WORKERS=6
PATTERN="*.laz"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workers) WORKERS="$2"; shift 2 ;;
    --pattern) PATTERN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

LIDAR_DIR="$(cd "$(dirname "$0")" && pwd)"

source ~/lidar-env/bin/activate

echo "LAZ source : $LAZ_DIR"
echo "Output     : $OUT_DIR"
echo "Pattern    : $PATTERN"
echo "Workers    : $WORKERS"
echo ""

python "$LIDAR_DIR/batch_rasterize.py" "$LAZ_DIR" \
    --pattern "$PATTERN" \
    --out     "$OUT_DIR" \
    --workers "$WORKERS"
