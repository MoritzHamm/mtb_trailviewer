#!/usr/bin/env python3
"""
Compute a rock / cliff likelihood raster from a 1 m DTM GeoTIFF or VRT.

Two DTM-derived signals, chosen against known spots around Lövberget/Jungfruberget
(see foundation/CLAUDE.md "Rock / cliff layer" for the calibration):

  roughness — local RMS (5×5) of DTM − Gaussian(DTM, σ=3 m). Boulder fields, blocky
              ground and the rubble around rock faces sit at 0.3–0.7 m; smooth till
              slopes stay below ~0.2 m however steep they are.
  slope     — at native 1 m resolution, rock faces reach 40–60°+ where almost
              nothing else natural does.

Man-made edges (road cuts, embankments, building footprints, gap-filled lake shores)
score just as high on both, so OSM roads/tracks/railways/buildings/water are buffered
and masked to 0 (--osm-dir; skipped if the directory doesn't exist).

Output (uint8 GeoTIFF, tiled + deflate, nodata=0) — two bands in one channel so the
viewer can colour cliff faces apart from rough ground:
    0        nothing (also outside DTM coverage)
    1–127    rough ground, strength from --rough-min to --rough-max metres
    128–255  cliff face, strength from --cliff-min to --cliff-max degrees
             (takes precedence over roughness in the same cell)

nodata=0 matters downstream: generate_overlay_tiles.py --rock max-resamples this, and
excluding 0 keeps tiles with no rock at all from being written.

Usage:
    python compute_rock.py ~/lidar-output/dtm/merged_dtm.vrt ~/lidar-output/rock.tif
    python compute_rock.py merged_dtm.vrt rock_test.tif --bbox 527500 6717500 537500 6727500
"""

import argparse
import itertools
import math
import multiprocessing
import os
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds
from scipy.ndimage import distance_transform_edt, gaussian_filter, uniform_filter

from log_utils import log, Progress

OVERLAP = 32   # > 3σ of the 3 m Gaussian + the 5×5 RMS window, with margin

# Buffer radius (m) per OSM layer for the man-made-edge mask. Paths are deliberately
# not masked: they're narrow, cut no embankments, and often run right over rock.
OSM_MASK_LAYERS = {
    'roads':     10.0,
    'railways':  10.0,
    'tracks':     5.0,
    'buildings':  5.0,
    'water':      3.0,   # natural=water only — wetlands aren't gap-filled flats
}

# Set in main() before the pool forks, so workers inherit them without pickling
_MASK_GEOMS = None   # numpy array of shapely geometries (EPSG:3006, already buffered)
_MASK_TREE  = None   # shapely STRtree over _MASK_GEOMS


# ---------------------------------------------------------------------------
# OSM mask
# ---------------------------------------------------------------------------

def load_osm_mask(osm_dir: Path, bounds_3006: tuple) -> list:
    import geopandas as gpd
    from pyproj import Transformer
    t = Transformer.from_crs(3006, 4326, always_xy=True)
    w, s = t.transform(bounds_3006[0], bounds_3006[1])
    e, n = t.transform(bounds_3006[2], bounds_3006[3])
    bbox_wgs = (min(w, e) - 0.01, min(s, n) - 0.01, max(w, e) + 0.01, max(s, n) + 0.01)

    geoms = []
    for layer, buf in OSM_MASK_LAYERS.items():
        path = osm_dir / f'{layer}.geojson'
        if not path.exists():
            log(f"  OSM mask: {layer} missing, skipped")
            continue
        gdf = gpd.read_file(path, bbox=bbox_wgs)
        if layer == 'water' and 'natural' in gdf.columns:
            gdf = gdf[gdf['natural'] != 'wetland']
        if gdf.empty:
            continue
        gdf = gdf.to_crs(3006)
        if layer == 'water':
            # Only the shoreline matters (gap-filled flats are already smooth)
            geoms.extend(gdf.geometry.boundary.buffer(buf).tolist())
        else:
            geoms.extend(gdf.geometry.buffer(buf).tolist())
        log(f"  OSM mask: {layer:10s} {len(gdf):7,} features, buffer {buf:.0f} m")
    return [g for g in geoms if g is not None and not g.is_empty]


# ---------------------------------------------------------------------------
# Block worker
# ---------------------------------------------------------------------------

def _process_block(args: tuple) -> tuple:
    (src_path, row_start, col_start, row_end, col_end,
     rough_min, rough_max, cliff_min, cliff_max) = args

    with rasterio.open(src_path) as src:
        height, width = src.height, src.width
        nodata = src.nodata
        res = src.res[0]
        ext_r0 = max(0, row_start - OVERLAP)
        ext_c0 = max(0, col_start - OVERLAP)
        ext_r1 = min(height, row_end + OVERLAP)
        ext_c1 = min(width,  col_end + OVERLAP)
        ext_win = Window(ext_c0, ext_r0, ext_c1 - ext_c0, ext_r1 - ext_r0)
        data = src.read(1, window=ext_win, out_dtype='float64')
        ext_tf = src.window_transform(ext_win)

    inner_h, inner_w = row_end - row_start, col_end - col_start
    ir0, ic0 = row_start - ext_r0, col_start - ext_c0
    out_window = Window(col_start, row_start, inner_w, inner_h)

    nodata_mask = ~np.isfinite(data) if nodata is None else (data == nodata) | ~np.isfinite(data)
    if nodata_mask.all():
        return out_window, np.zeros((inner_h, inner_w), np.uint8)
    if nodata_mask.any():
        _, idx = distance_transform_edt(nodata_mask, return_indices=True)
        data = data[idx[0], idx[1]]

    gy, gx = np.gradient(data, res)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    resid = data - gaussian_filter(data, 3.0 / res)
    rough = np.sqrt(np.clip(uniform_filter(resid * resid, 5), 0, None))

    t_rough = np.clip((rough - rough_min) / (rough_max - rough_min), 0, 1)
    t_cliff = np.clip((slope - cliff_min) / (cliff_max - cliff_min), 0, 1)
    out = np.where(t_rough > 0, 1 + np.round(t_rough * 126), 0)
    out = np.where(t_cliff > 0, 128 + np.round(t_cliff * 127), out).astype(np.uint8)
    out[nodata_mask] = 0

    if _MASK_TREE is not None:
        from shapely.geometry import box
        x0, y1 = ext_tf.c, ext_tf.f
        x1, y0 = x0 + data.shape[1] * res, y1 - data.shape[0] * res
        hits = _MASK_TREE.query(box(x0, y0, x1, y1))
        if len(hits):
            m = rasterize(((g, 1) for g in _MASK_GEOMS[hits]), out_shape=data.shape,
                          transform=ext_tf, fill=0, dtype='uint8')
            out[m.astype(bool)] = 0

    return out_window, out[ir0:ir0 + inner_h, ic0:ic0 + inner_w]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    global _MASK_GEOMS, _MASK_TREE
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input DTM GeoTIFF or VRT (1 m, EPSG:3006)')
    ap.add_argument('output', help='Output rock GeoTIFF (uint8, see encoding above)')
    ap.add_argument('--bbox', nargs=4, type=float, default=None,
                    metavar=('MINX', 'MINY', 'MAXX', 'MAXY'),
                    help='Restrict to a SWEREF99TM bbox (default: full input extent)')
    ap.add_argument('--osm-dir', default='/mnt/g/lidar-output/osm_layers',
                    help='OSM GeoJSON layers for the man-made-edge mask '
                         '(default: /mnt/g/lidar-output/osm_layers; "" disables)')
    ap.add_argument('--rough-min', type=float, default=0.2, help='metres → band start (default 0.2)')
    ap.add_argument('--rough-max', type=float, default=0.7, help='metres → band full (default 0.7)')
    ap.add_argument('--cliff-min', type=float, default=40.0, help='degrees → band start (default 40)')
    ap.add_argument('--cliff-max', type=float, default=60.0, help='degrees → band full (default 60)')
    ap.add_argument('--block',   type=int, default=4096, help='Inner block size in px (default 4096)')
    ap.add_argument('--workers', type=int, default=min(8, os.cpu_count() or 4),
                    help='Parallel workers (default: min(8, cpu_count))')
    args = ap.parse_args()

    with rasterio.open(args.input) as src:
        profile = src.profile.copy()
        full = Window(0, 0, src.width, src.height)
        if args.bbox:
            win = from_bounds(*args.bbox, transform=src.transform).round_offsets().round_lengths()
            win = win.intersection(full)
        else:
            win = full
        bounds = rasterio.windows.bounds(win, src.transform)
        out_tf = src.window_transform(win)
        log(f"Input : {args.input}  {src.width:,}×{src.height:,} px")
    r_off, c_off = int(win.row_off), int(win.col_off)
    height, width = int(win.height), int(win.width)
    log(f"Region: {bounds[0]:.0f} {bounds[1]:.0f} – {bounds[2]:.0f} {bounds[3]:.0f}  "
        f"({width:,}×{height:,} px)")

    if args.osm_dir and Path(args.osm_dir).is_dir():
        from shapely import STRtree
        geoms = load_osm_mask(Path(args.osm_dir), bounds)
        if geoms:
            _MASK_GEOMS = np.array(geoms, dtype=object)
            _MASK_TREE = STRtree(_MASK_GEOMS)
    else:
        log("  OSM mask: disabled (no --osm-dir)")

    profile.update(
        driver='GTiff', dtype='uint8', count=1, nodata=0,
        width=width, height=height, transform=out_tf,
        compress='deflate', predictor=2, tiled=True, blockxsize=256, blockysize=256,
        BIGTIFF='IF_SAFER',
    )

    block_args = []
    for br in range(math.ceil(height / args.block)):
        for bc in range(math.ceil(width / args.block)):
            r0, c0 = br * args.block, bc * args.block
            block_args.append((args.input, r_off + r0, c_off + c0,
                               r_off + min(r0 + args.block, height),
                               c_off + min(c0 + args.block, width),
                               args.rough_min, args.rough_max,
                               args.cliff_min, args.cliff_max))
    total = len(block_args)
    log(f"Blocks: {total}  block={args.block}px  workers={args.workers}")

    # fork, so workers inherit the mask geometries/tree without pickling them
    ctx = multiprocessing.get_context('fork')
    max_in_flight = args.workers * 2
    progress = Progress(total)
    done = 0
    with rasterio.open(args.output, 'w', **profile) as dst:
        with ProcessPoolExecutor(max_workers=args.workers, mp_context=ctx) as pool:
            it = iter(block_args)
            pending = {pool.submit(_process_block, a) for a in itertools.islice(it, max_in_flight)}
            while pending:
                finished, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    window, u8 = future.result()
                    window = Window(window.col_off - c_off, window.row_off - r_off,
                                    window.width, window.height)
                    dst.write(u8[np.newaxis], window=window)
                    done += 1
                    progress.update(done, 'blocks')
                    nxt = next(it, None)
                    if nxt is not None:
                        pending.add(pool.submit(_process_block, nxt))
    progress.done()

    size_mb = Path(args.output).stat().st_size / 1e6
    log(f"Done: {args.output}  ({size_mb:.1f} MB)")
    log("Next: python generate_overlay_tiles.py --rock " f"{args.output} --out <dir> --zoom 12 16")


if __name__ == '__main__':
    main()
