#!/usr/bin/env python3
"""
Batch DTM rasterizer: process a directory of LAZ files → per-tile DTM GeoTIFFs,
then stitch them into a single GDAL VRT ready for tile generation.

Usage:
    # Test cluster (96 tiles, ~30 min on 4 cores)
    python batch_rasterize.py /mnt/g/Download \
        --pattern "20D020_67[1-3]_5[01]_*.laz" \
        --out /mnt/g/lidar-output/test_dtm \
        --workers 4

    # All tiles in a product
    python batch_rasterize.py /mnt/g/Download \
        --pattern "20D020_*.laz" \
        --out /mnt/g/lidar-output/dtm \
        --workers 8
"""

import argparse
import glob
import subprocess
import sys
import time
from multiprocessing import Pool, cpu_count
from pathlib import Path

import numpy as np
import laspy
import rasterio
from rasterio.transform import from_origin
from scipy import ndimage
from scipy.ndimage import distance_transform_edt

EPSG       = 3006
RESOLUTION = 1.0   # metres


# ---------------------------------------------------------------------------
# DTM extraction  (ground class only, gap-filled, compressed)
# ---------------------------------------------------------------------------

def _fill_gaps(grid: np.ndarray) -> np.ndarray:
    filled = grid.copy()
    kernel = np.ones((3, 3))
    for _ in range(5):
        nan_mask = np.isnan(filled)
        if not nan_mask.any():
            break
        s = ndimage.convolve(np.where(nan_mask, 0, filled), kernel, mode='nearest')
        c = ndimage.convolve((~nan_mask).astype(float),      kernel, mode='nearest')
        with np.errstate(invalid='ignore'):
            mean = s / c
        fillable = nan_mask & (c > 0)
        filled[fillable] = mean[fillable]
    nan_mask = np.isnan(filled)
    if nan_mask.any():
        _, idx = distance_transform_edt(nan_mask, return_indices=True)
        filled[nan_mask] = filled[idx[0][nan_mask], idx[1][nan_mask]]
    return filled


def dtm_from_laz(laz_path: Path, out_path: Path,
                 resolution: float = RESOLUTION, epsg: int = EPSG) -> None:
    """Extract ground DTM from a single LAZ file and write a compressed GeoTIFF."""
    with laspy.open(laz_path) as f:
        las = f.read()

    x   = np.array(las.x)
    y   = np.array(las.y)
    z   = np.array(las.z)
    cls = np.array(las.classification)

    # ground points only (class 2)
    mask = cls == 2
    xg, yg, zg = x[mask], y[mask], z[mask]

    x_min, x_max = x.min(), x.max()
    y_min, y_max = y.min(), y.max()
    cols = int(np.ceil((x_max - x_min) / resolution))
    rows = int(np.ceil((y_max - y_min) / resolution))

    ci = ((xg - x_min) / resolution).astype(np.int32)
    ri = ((y_max - yg) / resolution).astype(np.int32)
    valid = (ci >= 0) & (ci < cols) & (ri >= 0) & (ri < rows)
    ri, ci, zg = ri[valid], ci[valid], zg[valid]

    accum = np.zeros((rows, cols), dtype=np.float64)
    count = np.zeros((rows, cols), dtype=np.int32)
    np.add.at(accum, (ri, ci), zg)
    np.add.at(count, (ri, ci), 1)

    dtm = np.full((rows, cols), np.nan, dtype=np.float64)
    has = count > 0
    dtm[has] = accum[has] / count[has]
    dtm = _fill_gaps(dtm)

    transform = from_origin(x_min, y_max, resolution, resolution)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w",
        driver="GTiff", height=rows, width=cols,
        count=1, dtype=np.float32,
        crs=f"EPSG:{epsg}", transform=transform, nodata=np.nan,
        compress="deflate", predictor=2, zlevel=6,
    ) as dst:
        dst.write(dtm.astype(np.float32), 1)


# ---------------------------------------------------------------------------
# Worker (runs in a subprocess via multiprocessing)
# ---------------------------------------------------------------------------

def _worker(args: tuple) -> tuple[str, float, str]:
    """Process one LAZ file.  Returns (stem, elapsed_s, status_msg)."""
    laz_path, out_dir = args
    laz_path = Path(laz_path)
    out_path = Path(out_dir) / f"{laz_path.stem}_dtm.tif"

    if out_path.exists() and out_path.stat().st_size > 0:
        return laz_path.stem, 0.0, "skip"

    t0 = time.monotonic()
    try:
        dtm_from_laz(laz_path, out_path)
        return laz_path.stem, time.monotonic() - t0, "ok"
    except Exception as exc:
        return laz_path.stem, time.monotonic() - t0, f"ERROR: {exc}"


# ---------------------------------------------------------------------------
# VRT builder
# ---------------------------------------------------------------------------

def build_vrt(dtm_dir: Path, vrt_path: Path) -> None:
    tifs = sorted(t for t in dtm_dir.glob("*_dtm.tif") if t.stat().st_size > 0)
    if not tifs:
        print("No DTM files found — skipping VRT build.")
        return

    print(f"\nBuilding VRT from {len(tifs)} files → {vrt_path}")
    cmd = [
        "gdalbuildvrt",
        "-resolution", "highest",
        "-r", "bilinear",
        str(vrt_path),
        *[str(t) for t in tifs],
    ]
    subprocess.run(cmd, check=True)
    print(f"VRT ready: {vrt_path}")


def build_overviews(vrt_path: Path) -> None:
    print(f"\nBuilding overviews (gdaladdo) — this takes a few minutes …")
    cmd = ["gdaladdo", "-ro", str(vrt_path), "2", "4", "8", "16", "32", "64", "128", "256"]
    subprocess.run(cmd, check=True)
    print("Overviews done.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("laz_dir",
                        help="Directory containing LAZ files")
    parser.add_argument("--pattern", default="*.laz",
                        help="Glob pattern to filter LAZ files (default: *.laz)")
    parser.add_argument("--out", required=True,
                        help="Output directory for DTM GeoTIFFs")
    parser.add_argument("--workers", type=int, default=min(4, cpu_count()),
                        help=f"Parallel workers (default: min(4, cpu_count())={min(4, cpu_count())})")
    parser.add_argument("--no-vrt", action="store_true",
                        help="Skip VRT build after processing")
    parser.add_argument("--no-overviews", action="store_true",
                        help="Skip gdaladdo overview build after VRT")
    args = parser.parse_args()

    laz_files = sorted(glob.glob(str(Path(args.laz_dir) / args.pattern)))
    if not laz_files:
        print(f"No files matched: {Path(args.laz_dir) / args.pattern}")
        sys.exit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    already_done = sum(
        1 for f in laz_files
        if (out_dir / f"{Path(f).stem}_dtm.tif").exists()
    )

    print(f"LAZ files found : {len(laz_files)}")
    print(f"Already done    : {already_done}")
    print(f"To process      : {len(laz_files) - already_done}")
    print(f"Workers         : {args.workers}")
    print(f"Output dir      : {out_dir}")
    print()

    work = [(f, str(out_dir)) for f in laz_files]
    t_start = time.monotonic()
    done = 0
    errors = []

    with Pool(processes=args.workers) as pool:
        for stem, elapsed, status in pool.imap_unordered(_worker, work):
            done += 1
            if status == "skip":
                tag = "·"
            elif status == "ok":
                tag = "✓"
                print(f"  {tag} {stem}  ({elapsed:.1f}s)  [{done}/{len(laz_files)}]")
            else:
                tag = "✗"
                errors.append((stem, status))
                print(f"  {tag} {stem}  {status}", flush=True)

    elapsed_total = time.monotonic() - t_start
    processed = done - already_done - len(errors)
    print(f"\nFinished: {processed} processed, {already_done} skipped, "
          f"{len(errors)} errors  ({elapsed_total:.0f}s total)")

    if errors:
        print("\nFailed files:")
        for stem, msg in errors:
            print(f"  {stem}: {msg}")

    if not args.no_vrt:
        vrt_path = out_dir / "merged.vrt"
        build_vrt(out_dir, vrt_path)
        if not args.no_overviews:
            build_overviews(vrt_path)
        print(f"\nNext step:")
        print(f"  python generate_elevation_tiles.py {vrt_path} /mnt/g/lidar-output/tiles --zoom 8 15")


if __name__ == "__main__":
    main()
