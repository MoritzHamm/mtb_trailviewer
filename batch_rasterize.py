#!/usr/bin/env python3
"""
Batch rasterizer: LAZ files → per-tile DTM + CHM GeoTIFFs + merged VRTs.

Each LAZ tile produces:
  {stem}_dtm.tif  — ground DTM (class 2, mean Z, gap-filled)
  {stem}_chm.tif  — canopy height model (DSM − DTM, clamped ≥ 0)

Both files are written to --out.  A merged VRT is built for each at the end.
Existing files are skipped, so re-running is safe and resumes from where it
stopped.  If a DTM exists but CHM is missing the LAZ is re-read to build DSM.

Usage:
    # Test cluster
    python batch_rasterize.py /mnt/g/Download \\
        --pattern "20D020_67[1-3]_5[01]_*.laz" \\
        --out /mnt/g/lidar-output/dtm \\
        --workers 4

    # All of Dalarna
    python batch_rasterize.py /mnt/g/Download \\
        --pattern "*.laz" \\
        --out /mnt/g/lidar-output/dtm \\
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
# Helpers
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


def _write_tif(path: Path, data: np.ndarray, transform, epsg: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path, 'w', driver='GTiff',
        height=data.shape[0], width=data.shape[1],
        count=1, dtype=np.float32,
        crs=f'EPSG:{epsg}', transform=transform, nodata=np.nan,
        compress='deflate', predictor=2, zlevel=6,
    ) as dst:
        dst.write(data.astype(np.float32), 1)


# ---------------------------------------------------------------------------
# Per-tile processing
# ---------------------------------------------------------------------------

def process_tile(laz_path: Path,
                 dtm_path: Path, chm_path: Path,
                 write_dtm: bool, write_chm: bool,
                 resolution: float = RESOLUTION, epsg: int = EPSG) -> None:
    """Read one LAZ file and write DTM and/or CHM as needed."""
    with laspy.open(laz_path) as f:
        las = f.read()

    x   = np.array(las.x)
    y   = np.array(las.y)
    z   = np.array(las.z)
    cls = np.array(las.classification)

    x_min, x_max = x.min(), x.max()
    y_min, y_max = y.min(), y.max()
    cols = int(np.ceil((x_max - x_min) / resolution))
    rows = int(np.ceil((y_max - y_min) / resolution))

    transform = from_origin(x_min, y_max, resolution, resolution)

    def to_idx(px, py):
        ci = ((px - x_min) / resolution).astype(np.int32)
        ri = ((y_max - py) / resolution).astype(np.int32)
        ok = (ci >= 0) & (ci < cols) & (ri >= 0) & (ri < rows)
        return ri, ci, ok

    # --- DTM (ground class 2, mean Z) ---
    mask_gnd = cls == 2
    ri_g, ci_g, ok_g = to_idx(x[mask_gnd], y[mask_gnd])
    zg = z[mask_gnd]

    accum = np.zeros((rows, cols), dtype=np.float64)
    count = np.zeros((rows, cols), dtype=np.int32)
    np.add.at(accum, (ri_g[ok_g], ci_g[ok_g]), zg[ok_g])
    np.add.at(count, (ri_g[ok_g], ci_g[ok_g]), 1)

    dtm = np.full((rows, cols), np.nan, dtype=np.float32)
    has = count > 0
    dtm[has] = (accum[has] / count[has]).astype(np.float32)
    dtm = _fill_gaps(dtm)

    if write_dtm:
        _write_tif(dtm_path, dtm, transform, epsg)

    # --- DSM (all returns, max Z) → CHM ---
    if write_chm:
        ri_a, ci_a, ok_a = to_idx(x, y)
        dsm = np.full((rows, cols), -np.inf, dtype=np.float32)
        np.maximum.at(dsm, (ri_a[ok_a], ci_a[ok_a]), z[ok_a].astype(np.float32))
        dsm[dsm == -np.inf] = np.nan
        dsm = _fill_gaps(dsm)

        chm = dsm - dtm
        chm = _fill_gaps(chm)
        chm = np.maximum(chm, 0)
        chm[chm < 0.5] = 0
        _write_tif(chm_path, chm, transform, epsg)


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

def _worker(args: tuple) -> tuple[str, float, str]:
    laz_path, out_dir = args
    laz_path = Path(laz_path)
    dtm_path = Path(out_dir) / f'{laz_path.stem}_dtm.tif'
    chm_path = Path(out_dir) / f'{laz_path.stem}_chm.tif'

    dtm_done = dtm_path.exists() and dtm_path.stat().st_size > 0
    chm_done = chm_path.exists() and chm_path.stat().st_size > 0

    if dtm_done and chm_done:
        return laz_path.stem, 0.0, 'skip'

    t0 = time.monotonic()
    try:
        process_tile(laz_path, dtm_path, chm_path,
                     write_dtm=not dtm_done, write_chm=not chm_done)
        return laz_path.stem, time.monotonic() - t0, 'ok'
    except Exception as exc:
        return laz_path.stem, time.monotonic() - t0, f'ERROR: {exc}'


# ---------------------------------------------------------------------------
# VRT builder
# ---------------------------------------------------------------------------

def build_vrt(out_dir: Path, suffix: str) -> Path | None:
    tifs = sorted(
        t for t in out_dir.glob(f'*_{suffix}.tif') if t.stat().st_size > 0)
    if not tifs:
        print(f'  No {suffix} files found — skipping VRT.')
        return None

    vrt_path = out_dir / f'merged_{suffix}.vrt'
    print(f'\nBuilding {suffix.upper()} VRT from {len(tifs)} files → {vrt_path}')
    subprocess.run([
        'gdalbuildvrt', '-resolution', 'highest', '-r', 'bilinear',
        str(vrt_path), *[str(t) for t in tifs],
    ], check=True)
    return vrt_path


def build_overviews(vrt_path: Path) -> None:
    print(f'Building overviews for {vrt_path.name} …')
    subprocess.run([
        'gdaladdo', '-ro', str(vrt_path),
        '2', '4', '8', '16', '32', '64', '128', '256',
    ], check=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('laz_dir',            help='Directory containing LAZ files')
    ap.add_argument('--pattern',          default='*.laz',
                    help='Glob pattern to filter LAZ files (default: *.laz)')
    ap.add_argument('--out',              required=True,
                    help='Output directory for GeoTIFFs and VRTs')
    ap.add_argument('--workers',          type=int, default=min(4, cpu_count()),
                    help=f'Parallel workers (default: min(4,nCPU)={min(4,cpu_count())})')
    ap.add_argument('--no-vrt',           action='store_true',
                    help='Skip VRT build')
    ap.add_argument('--no-overviews',     action='store_true',
                    help='Skip gdaladdo overviews')
    args = ap.parse_args()

    laz_files = sorted(glob.glob(str(Path(args.laz_dir) / args.pattern)))
    if not laz_files:
        print(f'No files matched: {Path(args.laz_dir) / args.pattern}')
        sys.exit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    n_dtm_done = sum(1 for f in laz_files
                     if (out_dir / f'{Path(f).stem}_dtm.tif').exists())
    n_chm_done = sum(1 for f in laz_files
                     if (out_dir / f'{Path(f).stem}_chm.tif').exists())
    n_both     = sum(1 for f in laz_files
                     if (out_dir / f'{Path(f).stem}_dtm.tif').exists()
                     and (out_dir / f'{Path(f).stem}_chm.tif').exists())

    print(f'LAZ files    : {len(laz_files)}')
    print(f'DTM done     : {n_dtm_done}')
    print(f'CHM done     : {n_chm_done}')
    print(f'Both done    : {n_both}  (will skip)')
    print(f'To process   : {len(laz_files) - n_both}')
    print(f'Workers      : {args.workers}')
    print(f'Output dir   : {out_dir}')
    print()

    work    = [(f, str(out_dir)) for f in laz_files]
    t_start = time.monotonic()
    done = ok = skipped = 0
    errors  = []

    with Pool(processes=args.workers) as pool:
        for stem, elapsed, status in pool.imap_unordered(_worker, work):
            done += 1
            if status == 'skip':
                skipped += 1
            elif status == 'ok':
                ok += 1
                print(f'  ✓ {stem}  ({elapsed:.1f}s)  [{done}/{len(laz_files)}]')
            else:
                errors.append((stem, status))
                print(f'  ✗ {stem}  {status}')

    print(f'\nFinished: {ok} processed, {skipped} skipped, {len(errors)} errors  '
          f'({time.monotonic() - t_start:.0f}s)')
    if errors:
        print('\nFailed:')
        for stem, msg in errors:
            print(f'  {stem}: {msg}')

    if args.no_vrt:
        return

    dtm_vrt = build_vrt(out_dir, 'dtm')
    chm_vrt = build_vrt(out_dir, 'chm')

    if not args.no_overviews:
        for vrt in [dtm_vrt, chm_vrt]:
            if vrt:
                build_overviews(vrt)

    print('\nNext: update build_pipeline.sh with these VRT paths:')
    if dtm_vrt: print(f'  DTM_VRT="{dtm_vrt}"')
    if chm_vrt: print(f'  CHM_VRT="{chm_vrt}"')


if __name__ == '__main__':
    main()
