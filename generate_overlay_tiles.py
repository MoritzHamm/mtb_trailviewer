#!/usr/bin/env python3
"""
Generate RGBA overlay tile pyramid from analysis-layer GeoTIFFs.

Packs four 8-bit analysis layers into a single RGBA PNG tile set:

  R = LRM      128=flat, <128=depression, >128=raised
  G = SVF      255=open sky, 0=enclosed  (placeholder 0 until SVF is computed)
  B = CHM      0=bare ground, 255=35 m canopy
  A = Wetness  0=dry (SLU 0), 255=wet (SLU 100)

Any channel whose source file is not supplied is filled with its neutral value.
Output tiles go to out_dir/{z}/{x}/{y}.png and are suitable for pack_tiles.py.

Usage:
    python generate_overlay_tiles.py \\
        --lrm     /mnt/g/lidar-output/lovberget_lrm.tif \\
        --chm     /mnt/g/lidar-output/lovberget_chm.tif \\
        --wetness /mnt/g/lidar-output/lovberget_wetness.tif \\
        --out     viewer/overlay-tiles \\
        --zoom    12 17
"""

import argparse
import math
import os
import shutil
import tempfile
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image
import rasterio
from rasterio.crs import CRS
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import Affine
from scipy.ndimage import distance_transform_edt

TILE_SIZE  = 256
HALF_WORLD = 20037508.3427892
WEB_MERC   = CRS.from_epsg(3857)
WGS84      = CRS.from_epsg(4326)

NEUTRAL = {'lrm': 128, 'svf': 0, 'chm': 0, 'wetness': 0}


# ---------------------------------------------------------------------------
# Tile math
# ---------------------------------------------------------------------------

def tile_bounds_3857(tx, ty, z):
    tile_m = 2 * HALF_WORLD / (2 ** z)
    west  =  tx      * tile_m - HALF_WORLD
    east  = (tx + 1) * tile_m - HALF_WORLD
    north = HALF_WORLD -  ty      * tile_m
    south = HALF_WORLD - (ty + 1) * tile_m
    return west, south, east, north


def tiles_for_bounds(west, south, east, north, zoom):
    n = 2 ** zoom
    def lon_to_tx(lon): return int((lon + 180) / 360 * n)
    def lat_to_ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    x0, x1 = lon_to_tx(west),  lon_to_tx(east)
    y0, y1 = lat_to_ty(north), lat_to_ty(south)
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            yield tx, ty


# ---------------------------------------------------------------------------
# Source region caching
# Sources on /mnt/ (Windows drives) are slow to do random window reads on.
# Extract the relevant region to a local temp GeoTIFF once before tiling.
# ---------------------------------------------------------------------------

def _cache_region(src_path: str, west_wgs: float, south_wgs: float,
                  east_wgs: float, north_wgs: float, tmp_dir: Path) -> str:
    """
    Extract the region [west,south,east,north] (WGS84) from src_path into a
    local LZW-compressed tiled GeoTIFF.  Returns the path to the local file.
    Skips extraction if the local file already exists.
    """
    name = Path(src_path).stem + '_region.tif'
    dst_path = tmp_dir / name
    if dst_path.exists():
        return str(dst_path)

    with rasterio.open(src_path) as src:
        bounds_src = transform_bounds(WGS84, src.crs,
                                      west_wgs, south_wgs, east_wgs, north_wgs)
        win = src.window(*bounds_src)
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))

        profile = src.profile.copy()
        profile.update(
            width=math.ceil(win.width),
            height=math.ceil(win.height),
            transform=src.window_transform(win),
            compress='lzw',
            tiled=True, blockxsize=256, blockysize=256,
            bigtiff='IF_SAFER',
        )
        data = src.read(window=win)

    with rasterio.open(dst_path, 'w', **profile) as dst:
        dst.write(data)

    size_mb = dst_path.stat().st_size / 1e6
    print(f"    cached {Path(src_path).name} → {name}  ({size_mb:.0f} MB)")
    return str(dst_path)


# ---------------------------------------------------------------------------
# Strip I/O — one file-open covers a full row of tiles
# ---------------------------------------------------------------------------

def fill_nodata(data, mask):
    if not mask.any():
        return data
    _, idx = distance_transform_edt(mask, return_indices=True)
    out = data.copy()
    out[mask] = data[idx[0][mask], idx[1][mask]]
    return out


def _read_strip(src_path: str, strip_transform: Affine, strip_w: int,
                neutral: float, resampling=Resampling.bilinear) -> np.ndarray | None:
    """Read one channel for a horizontal strip (TILE_SIZE rows, strip_w cols)."""
    dst = np.full((TILE_SIZE, strip_w), np.nan, dtype=np.float32)
    with rasterio.open(src_path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=strip_transform,
            dst_crs=WEB_MERC,
            resampling=resampling,
            src_nodata=src.nodata,
            dst_nodata=np.nan,
        )
    if not np.any(~np.isnan(dst)):
        return None
    mask = ~np.isfinite(dst)
    if mask.any():
        dst = fill_nodata(dst, mask)
        dst[mask] = neutral
    return dst


def _read_lrm_strip(src_path: str, strip_transform: Affine,
                    strip_w: int, z: int) -> np.ndarray | None:
    """
    LRM strip with max-magnitude aggregation at low zoom.
    At Z15+ bilinear is used (near-native resolution, averaging is fine).
    Below Z15 we take two passes — max and min — then keep whichever pixel
    deviates most from 128, preserving trail features that bilinear would erase.
    """
    FLAT = 128.0

    def _pass(resampling):
        dst = np.full((TILE_SIZE, strip_w), FLAT, dtype=np.float32)
        with rasterio.open(src_path) as src:
            reproject(
                source=rasterio.band(src, 1), destination=dst,
                src_transform=src.transform, src_crs=src.crs,
                dst_transform=strip_transform, dst_crs=WEB_MERC,
                resampling=resampling,
                src_nodata=src.nodata, dst_nodata=FLAT,
            )
        return dst

    if z >= 15:
        dst = _pass(Resampling.bilinear)
    else:
        hi = _pass(Resampling.max)
        lo = _pass(Resampling.min)
        dst = np.where(hi - FLAT >= FLAT - lo, hi, lo)

    if not np.any(dst != FLAT):
        return None
    mask = ~np.isfinite(dst)
    if mask.any():
        dst = fill_nodata(dst, mask)
        dst[mask] = FLAT
    return dst


# ---------------------------------------------------------------------------
# Strip worker — called once per tile-row, processes all tiles in that row
# ---------------------------------------------------------------------------

def _strip_worker(args: tuple) -> int:
    """
    Process one horizontal strip: all tx values for a given ty at zoom z.
    Reads each source file once for the whole strip, then slices out tiles.
    Returns the number of tiles written.
    """
    paths, ty, tx_list, z, out_dir = args

    # Re-check which tiles still need writing (resume safety)
    tx_todo = [tx for tx in tx_list
               if not (Path(out_dir) / str(z) / str(tx) / f"{ty}.png").exists()
               and not (Path(out_dir) / str(z) / str(tx) / f"{ty}.empty").exists()]
    if not tx_todo:
        return 0

    # Strip covers tx_todo[0]..tx_todo[-1] (may include already-done gaps, cheap)
    tx_min, tx_max = tx_todo[0], tx_todo[-1]
    west  = tile_bounds_3857(tx_min, ty, z)[0]
    east  = tile_bounds_3857(tx_max, ty, z)[2]
    _, south, _, north = tile_bounds_3857(tx_min, ty, z)

    strip_w       = (tx_max - tx_min + 1) * TILE_SIZE
    pixel_m       = (east - west) / strip_w
    strip_tf      = Affine(pixel_m, 0, west, 0, -pixel_m, north)

    # Read each channel once for the whole strip
    lrm_s = _read_lrm_strip(paths['lrm'],     strip_tf, strip_w, z) if paths.get('lrm')     else None
    chm_s = _read_strip(    paths['chm'],     strip_tf, strip_w, 0.0) if paths.get('chm')     else None
    wet_s = _read_strip(    paths['wetness'], strip_tf, strip_w, 0.0) if paths.get('wetness') else None

    def to_uint8_lrm(a): return np.clip(np.round(a), 0, 255).astype(np.uint8)
    def to_uint8_chm(a): return np.clip(np.round(a / 35.0 * 255), 0, 255).astype(np.uint8)
    def to_uint8_wet(a): return np.clip(np.round(a * 2.55), 0, 255).astype(np.uint8)

    written = 0
    for tx in tx_todo:
        c0 = (tx - tx_min) * TILE_SIZE
        c1 = c0 + TILE_SIZE

        channels = {
            'lrm':     to_uint8_lrm(lrm_s[:, c0:c1]) if lrm_s is not None else None,
            'chm':     to_uint8_chm(chm_s[:, c0:c1]) if chm_s is not None else None,
            'wetness': to_uint8_wet(wet_s[:, c0:c1]) if wet_s is not None else None,
        }

        has_data = any(v is not None for v in channels.values())
        tile_path = Path(out_dir) / str(z) / str(tx) / f"{ty}.png"

        if not has_data:
            sentinel = Path(out_dir) / str(z) / str(tx) / f"{ty}.empty"
            sentinel.parent.mkdir(parents=True, exist_ok=True)
            sentinel.touch()
            continue

        def ch(key):
            v = channels.get(key)
            return v if v is not None else np.full((TILE_SIZE, TILE_SIZE),
                                                    NEUTRAL[key], dtype=np.uint8)

        rgba = np.stack([ch('lrm'), ch('svf'), ch('chm'), ch('wetness')], axis=-1)
        tile_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgba, 'RGBA').save(tile_path, compress_level=1)
        written += 1

    return written


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _scan_existing(out_dir: Path, z: int) -> set:
    z_dir = out_dir / str(z)
    if not z_dir.is_dir():
        return set()
    found = set()
    for x_entry in os.scandir(z_dir):
        if x_entry.is_dir():
            tx = int(x_entry.name)
            for y_entry in os.scandir(x_entry.path):
                if y_entry.name.endswith(('.png', '.empty')):
                    found.add((tx, int(y_entry.name.rsplit('.', 1)[0])))
    return found


def generate_overlay_tiles(paths: dict, out_dir: Path,
                            zoom_min: int, zoom_max: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    all_bounds = []
    for key, p in paths.items():
        if p:
            with rasterio.open(p) as src:
                b = transform_bounds(src.crs, WGS84, *src.bounds)
                all_bounds.append(b)
                print(f"  {key:8s}: {src.crs.to_epsg()}  {src.width}×{src.height} px  "
                      f"{b[0]:.3f}°E {b[1]:.3f}°N – {b[2]:.3f}°E {b[3]:.3f}°N")

    if not all_bounds:
        raise RuntimeError("No input files provided.")

    west  = max(b[0] for b in all_bounds)
    south = max(b[1] for b in all_bounds)
    east  = min(b[2] for b in all_bounds)
    north = min(b[3] for b in all_bounds)
    print(f"\n  Intersect: {west:.3f}°E {south:.3f}°N – {east:.3f}°E {north:.3f}°N")

    # Cache any sources on slow filesystems (/mnt/) to a local temp dir.
    # Workers only see the (possibly remapped) local paths.
    tmp_dir = out_dir / '.cache'
    tmp_dir.mkdir(exist_ok=True)
    cached_paths = {}
    print("\n  Caching sources...")
    for key, p in paths.items():
        if not p:
            cached_paths[key] = None
            continue
        if p.startswith('/mnt/'):
            cached_paths[key] = _cache_region(p, west, south, east, north, tmp_dir)
        else:
            cached_paths[key] = p
    cached_paths['svf'] = None  # placeholder

    workers = os.cpu_count() or 4
    print(f"\n  Workers : {workers}\n")

    total_written = 0
    total_skipped = 0

    for z in range(zoom_min, zoom_max + 1):
        all_tiles   = list(tiles_for_bounds(west, south, east, north, z))
        existing    = _scan_existing(out_dir, z)

        # Group remaining tiles by row (ty), preserving tx order
        rows: dict[int, list[int]] = {}
        for tx, ty in all_tiles:
            if (tx, ty) not in existing:
                rows.setdefault(ty, []).append(tx)

        n_todo = sum(len(v) for v in rows.values())
        print(f"Z{z:02d}  {len(all_tiles)} candidates  "
              f"{len(existing)} existing  {n_todo} to generate "
              f"in {len(rows)} strips")

        total_skipped += len(existing)
        if not rows:
            continue

        strip_args = [
            (cached_paths, ty, sorted(txs), z, str(out_dir))
            for ty, txs in sorted(rows.items())
        ]

        written = 0
        strips_done = 0
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for result in pool.map(_strip_worker, strip_args, chunksize=1):
                written += result
                strips_done += 1
                if strips_done % 10 == 0:
                    print(f"      {strips_done}/{len(strip_args)} strips  "
                          f"{written} tiles written", flush=True)

        print(f"      → {written} tiles written")
        total_written += written

    print(f"\nDone. {total_written} new + {total_skipped} existing = "
          f"{total_written + total_skipped} tiles in {out_dir}/")
    print(f"\nNext: pack into PMTiles with")
    print(f"  python pack_tiles.py {out_dir} overlay.pmtiles")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lrm',     help='LRM GeoTIFF  (uint8, 128=flat)  → R channel')
    ap.add_argument('--chm',     help='CHM GeoTIFF  (float32, metres)  → B channel')
    ap.add_argument('--wetness', help='Wetness GeoTIFF (float32, 0–100) → A channel')
    ap.add_argument('--out',     default='viewer/overlay-tiles',
                    help='Output tile directory (default: viewer/overlay-tiles)')
    ap.add_argument('--zoom',    nargs=2, type=int, default=[12, 17],
                    metavar=('MIN', 'MAX'), help='Zoom range (default: 12 17)')
    args = ap.parse_args()

    paths = {
        'lrm':     args.lrm,
        'svf':     None,
        'chm':     args.chm,
        'wetness': args.wetness,
    }

    if not any(paths.values()):
        ap.error("Provide at least one of --lrm, --chm, --wetness")

    print("Overlay tile inputs:")
    generate_overlay_tiles(paths, Path(args.out), *args.zoom)


if __name__ == '__main__':
    main()
