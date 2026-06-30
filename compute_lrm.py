#!/usr/bin/env python3
"""
Compute Local Relief Model (LRM) from a DTM GeoTIFF or VRT.

Processes in overlapping blocks so it works on datasets of any size,
including full-Dalarna VRTs that would never fit in RAM.

LRM = DTM − Gaussian_smooth(DTM, sigma)

Output (uint8 GeoTIFF, tiled + deflate compressed):
  128  = flat  ·  < 128 = depression  ·  > 128 = raised
  ±limit metres maps to 0–255  (default ±3 m)

Overlap must exceed 3×sigma to keep Gaussian edge artefacts outside the
inner block.  Default overlap=256 covers sigma≤85.

Usage:
    python compute_lrm.py merged.vrt dalarna_lrm.tif
    python compute_lrm.py merged.vrt dalarna_lrm.tif --sigma 50 --limit 3.0 --workers 8
"""

import argparse
import itertools
import math
import os
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import distance_transform_edt, gaussian_filter


# ---------------------------------------------------------------------------
# Block worker  (must be top-level for ProcessPoolExecutor pickling)
# ---------------------------------------------------------------------------

def _process_block(args: tuple) -> tuple:
    """
    Read an extended block, compute LRM, return (window, uint8_array).
    window is the output Window (col_off, row_off, width, height).
    """
    src_path, row_start, col_start, row_end, col_end, overlap, sigma, limit = args

    with rasterio.open(src_path) as src:
        height, width = src.height, src.width
        nodata = src.nodata

        ext_r0 = max(0, row_start - overlap)
        ext_c0 = max(0, col_start - overlap)
        ext_r1 = min(height, row_end   + overlap)
        ext_c1 = min(width,  col_end   + overlap)

        data = src.read(1,
                        window=Window(ext_c0, ext_r0,
                                      ext_c1 - ext_c0, ext_r1 - ext_r0),
                        out_dtype='float32')

    inner_h = row_end - row_start
    inner_w = col_end - col_start
    inner_r0 = row_start - ext_r0
    inner_c0 = col_start - ext_c0

    nodata_mask = (~np.isfinite(data)) if nodata is None else (data == nodata)

    # Skip fully-empty blocks cheaply
    if nodata_mask.all():
        u8 = np.full((inner_h, inner_w), 128, dtype=np.uint8)
        out_window = Window(col_start, row_start, inner_w, inner_h)
        return out_window, u8

    # Fill nodata for clean Gaussian behaviour at coverage edges
    if nodata_mask.any():
        _, idx = distance_transform_edt(nodata_mask, return_indices=True)
        filled = data.copy()
        filled[nodata_mask] = data[idx[0][nodata_mask], idx[1][nodata_mask]]
    else:
        filled = data

    smoothed = gaussian_filter(filled, sigma=sigma)
    lrm      = filled - smoothed

    lrm_inner  = lrm[inner_r0:inner_r0 + inner_h, inner_c0:inner_c0 + inner_w]
    mask_inner = nodata_mask[inner_r0:inner_r0 + inner_h, inner_c0:inner_c0 + inner_w]

    scaled = np.clip(lrm_inner / limit, -1.0, 1.0)
    u8 = np.round((scaled + 1.0) * 127.5).astype(np.uint8)
    u8[mask_inner] = 128

    out_window = Window(col_start, row_start, inner_w, inner_h)
    return out_window, u8


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',     help='Input DTM GeoTIFF or VRT')
    ap.add_argument('output',    help='Output LRM GeoTIFF (uint8, 128=flat)')
    ap.add_argument('--sigma',   type=float, default=50.0,
                    help='Gaussian smoothing radius in pixels (default: 50)')
    ap.add_argument('--limit',   type=float, default=3.0,
                    help='±metres that map to 0/255 (default: 3.0)')
    ap.add_argument('--block',   type=int,   default=4096,
                    help='Inner block size in pixels (default: 4096)')
    ap.add_argument('--overlap', type=int,   default=256,
                    help='Overlap border in pixels; must be > 3×sigma (default: 256)')
    ap.add_argument('--workers', type=int,   default=min(8, os.cpu_count()),
                    help='Parallel workers (default: min(8, cpu_count))')
    args = ap.parse_args()

    if args.overlap < 3 * args.sigma:
        print(f"WARNING: overlap {args.overlap}px < 3×sigma={3*args.sigma:.0f}px — "
              f"edge artefacts likely. Try --overlap {math.ceil(3 * args.sigma) + 1}")

    with rasterio.open(args.input) as src:
        height, width = src.height, src.width
        profile = src.profile.copy()
        print(f"Input : {args.input}")
        print(f"  {width:,} × {height:,} px   CRS: {src.crs.to_epsg()}   nodata: {src.nodata}")

    n_br = math.ceil(height / args.block)
    n_bc = math.ceil(width  / args.block)
    total = n_br * n_bc
    est_gb = width * height / 1e9   # uint8 uncompressed
    print(f"Blocks: {n_bc} × {n_br} = {total:,}   "
          f"block={args.block}px  overlap={args.overlap}px")
    print(f"Params: sigma={args.sigma}  limit=±{args.limit}m  workers={args.workers}")
    print(f"Output: ~{est_gb:.1f} GB uncompressed (deflate will reduce this)")
    print()

    profile.update(
        driver='GTiff', dtype='uint8', count=1, nodata=None,
        compress='deflate', predictor=2,
        tiled=True, blockxsize=256, blockysize=256,
        BIGTIFF='IF_SAFER',
    )

    block_args = [
        (args.input,
         br * args.block, bc * args.block,
         min((br + 1) * args.block, height),
         min((bc + 1) * args.block, width),
         args.overlap, args.sigma, args.limit)
        for br in range(n_br)
        for bc in range(n_bc)
    ]

    # Submit at most workers*2 tasks at a time so completed result arrays
    # (16 MB each) don't accumulate in memory while disk I/O catches up.
    max_in_flight = args.workers * 2
    done = 0
    with rasterio.open(args.output, 'w', **profile) as dst:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            it = iter(block_args)
            pending = {pool.submit(_process_block, a)
                       for a in itertools.islice(it, max_in_flight)}
            while pending:
                finished, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    window, u8 = future.result()
                    dst.write(u8[np.newaxis], window=window)
                    done += 1
                    print(f"  {done:,}/{total:,}  ({done/total*100:.1f}%)",
                          end='\r', flush=True)
                    next_a = next(it, None)
                    if next_a is not None:
                        pending.add(pool.submit(_process_block, next_a))

    size_gb = Path(args.output).stat().st_size / 1e9
    print(f"\nDone: {args.output}  ({size_gb:.2f} GB compressed)")
    print("  128=flat  <128=depression  >128=raised")


if __name__ == '__main__':
    main()
