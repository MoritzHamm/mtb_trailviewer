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
        --zoom    12 15
"""

import argparse
import math
import os
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

# Neutral fill value per channel when source data is absent or nodata
NEUTRAL = {'lrm': 128, 'svf': 0, 'chm': 0, 'wetness': 0}


# ---------------------------------------------------------------------------
# Tile math  (same as generate_elevation_tiles.py)
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
# Per-channel reprojection + normalisation
# ---------------------------------------------------------------------------

def fill_nodata(data, mask):
    if not mask.any():
        return data
    _, idx = distance_transform_edt(mask, return_indices=True)
    out = data.copy()
    out[mask] = data[idx[0][mask], idx[1][mask]]
    return out


def reproject_to_tile(src_path: str, tx: int, ty: int, z: int,
                       neutral: int) -> np.ndarray:
    """
    Reproject one band of src_path to the tile's web-mercator bounds.
    Returns a float32 (TILE_SIZE × TILE_SIZE) array, or None if the
    source doesn't overlap the tile.
    """
    west, south, east, north = tile_bounds_3857(tx, ty, z)
    pixel_m       = (east - west) / TILE_SIZE
    dst_transform = Affine(pixel_m, 0, west, 0, -pixel_m, north)
    dst           = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)

    with rasterio.open(src_path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=dst_transform,
            dst_crs=WEB_MERC,
            resampling=Resampling.bilinear,
            src_nodata=src.nodata,
            dst_nodata=np.nan,
        )

    if not np.any(~np.isnan(dst)):
        return None   # no coverage — caller uses neutral fill

    nodata_mask = ~np.isfinite(dst)
    if nodata_mask.any():
        dst = fill_nodata(dst, nodata_mask)
        dst[nodata_mask] = neutral

    return dst


def to_uint8_lrm(arr: np.ndarray) -> np.ndarray:
    """LRM already stored as uint8 (128=flat); clamp and cast."""
    return np.clip(np.round(arr), 0, 255).astype(np.uint8)


def to_uint8_chm(arr: np.ndarray, max_m: float = 35.0) -> np.ndarray:
    """CHM: 0 m → 0, max_m → 255, clamp."""
    return np.clip(np.round(arr / max_m * 255), 0, 255).astype(np.uint8)


def to_uint8_wetness(arr: np.ndarray) -> np.ndarray:
    """SLU wetness band 1: 0–100 → 0–255."""
    return np.clip(np.round(arr * 2.55), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Tile worker
# ---------------------------------------------------------------------------

def _tile_worker(args: tuple) -> bool:
    paths, tx, ty, z, out_dir = args

    west, south, east, north = tile_bounds_3857(tx, ty, z)

    channels = {}

    if paths.get('lrm'):
        raw = reproject_to_tile(paths['lrm'], tx, ty, z, neutral=128)
        channels['lrm'] = to_uint8_lrm(raw) if raw is not None else None

    if paths.get('chm'):
        raw = reproject_to_tile(paths['chm'], tx, ty, z, neutral=0)
        channels['chm'] = to_uint8_chm(raw) if raw is not None else None

    if paths.get('wetness'):
        raw = reproject_to_tile(paths['wetness'], tx, ty, z, neutral=0)
        channels['wetness'] = to_uint8_wetness(raw) if raw is not None else None

    # Skip tile if none of the supplied channels has any coverage
    has_data = any(v is not None for v in channels.values())
    if not has_data:
        return False

    def ch(key):
        v = channels.get(key)
        return v if v is not None else np.full((TILE_SIZE, TILE_SIZE),
                                                NEUTRAL[key], dtype=np.uint8)

    rgba = np.stack([ch('lrm'), ch('svf'), ch('chm'), ch('wetness')], axis=-1)

    tile_path = Path(out_dir) / str(z) / str(tx) / f"{ty}.png"
    tile_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, 'RGBA').save(tile_path, compress_level=1)
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def generate_overlay_tiles(paths: dict, out_dir: Path,
                            zoom_min: int, zoom_max: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    # Determine coverage bounds from whichever sources exist
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

    west  = min(b[0] for b in all_bounds)
    south = min(b[1] for b in all_bounds)
    east  = max(b[2] for b in all_bounds)
    north = max(b[3] for b in all_bounds)
    print(f"\n  Union   : {west:.3f}°E {south:.3f}°N – {east:.3f}°E {north:.3f}°N")

    workers = os.cpu_count() or 4
    print(f"  Workers : {workers}\n")

    total_written = 0
    for z in range(zoom_min, zoom_max + 1):
        tile_list = [
            (paths, tx, ty, z, str(out_dir))
            for tx, ty in tiles_for_bounds(west, south, east, north, z)
        ]
        written = 0
        print(f"Z{z:02d}  {len(tile_list)} candidate tiles", end='', flush=True)
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for i, result in enumerate(pool.map(_tile_worker, tile_list, chunksize=8)):
                if result:
                    written += 1
                if (i + 1) % 200 == 0:
                    print(f"\n      {i+1}/{len(tile_list)} ({written} written)",
                          end='', flush=True)
        print(f"\n      → {written} tiles written")
        total_written += written

    print(f"\nDone. {total_written} tiles in {out_dir}/")
    print("\nNext: pack into PMTiles with")
    print(f"  python pack_tiles.py {out_dir} overlay.pmtiles")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lrm',     help='LRM GeoTIFF  (uint8, 128=flat)  → R channel')
    ap.add_argument('--chm',     help='CHM GeoTIFF  (float32, metres)  → B channel')
    ap.add_argument('--wetness', help='Wetness GeoTIFF (float32, 0–100) → A channel')
    ap.add_argument('--out',     default='viewer/overlay-tiles',
                    help='Output tile directory (default: viewer/overlay-tiles)')
    ap.add_argument('--zoom',    nargs=2, type=int, default=[12, 15],
                    metavar=('MIN', 'MAX'), help='Zoom range (default: 12 15)')
    args = ap.parse_args()

    paths = {
        'lrm':     args.lrm,
        'svf':     None,   # future
        'chm':     args.chm,
        'wetness': args.wetness,
    }

    if not any(paths.values()):
        ap.error("Provide at least one of --lrm, --chm, --wetness")

    print("Overlay tile inputs:")
    generate_overlay_tiles(paths, Path(args.out), *args.zoom)


if __name__ == '__main__':
    main()
