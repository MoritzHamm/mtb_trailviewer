#!/usr/bin/env python3
"""
Generate Mapbox terrain-RGB tiles from a DTM GeoTIFF.

Encoding:  height_m = -10000 + (R*65536 + G*256 + B) * 0.1
Output:    tiles/{z}/{x}/{y}.png  (XYZ, EPSG:3857)
Zoom range: Z12–Z15 by default (pass --zoom 12 15 to override)

Usage:
    python generate_elevation_tiles.py [dtm.tif] [out_dir] [--zoom 12 15]
"""

import json
import math
import os
import sys
import argparse
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
from PIL import Image
import rasterio
from rasterio.crs import CRS
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import Affine
from scipy.ndimage import distance_transform_edt

TILE_SIZE   = 256
HALF_WORLD  = 20037508.3427892
WEB_MERC    = CRS.from_epsg(3857)
WGS84       = CRS.from_epsg(4326)

DTM_PATH    = "/mnt/g/lidar-output/lovberget_dtm.tif"
OUT_DIR     = Path(__file__).parent / "viewer" / "tiles"


# ---------------------------------------------------------------------------
# Tile math
# ---------------------------------------------------------------------------

def tile_bounds_3857(tx: int, ty: int, z: int) -> tuple[float, float, float, float]:
    """Return (west, south, east, north) in EPSG:3857 for tile (tx, ty, z)."""
    tile_m = 2 * HALF_WORLD / (2 ** z)
    west  =  tx       * tile_m - HALF_WORLD
    east  = (tx + 1)  * tile_m - HALF_WORLD
    north = HALF_WORLD - ty       * tile_m
    south = HALF_WORLD - (ty + 1) * tile_m
    return west, south, east, north


def tiles_for_bounds(west: float, south: float, east: float, north: float,
                     zoom: int):
    """Yield (tx, ty) for all tiles that cover a WGS84 bounding box."""
    n = 2 ** zoom

    def lon_to_tx(lon: float) -> int:
        return int((lon + 180) / 360 * n)

    def lat_to_ty(lat: float) -> int:
        lat_r = math.radians(lat)
        return int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)

    x0, x1 = lon_to_tx(west),  lon_to_tx(east)
    y0, y1 = lat_to_ty(north), lat_to_ty(south)   # note: y increases southward

    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            yield tx, ty


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------

def encode_terrain_rgb(elev: np.ndarray) -> np.ndarray:
    """
    Encode float32 elevation array (H×W, metres) to uint8 RGB (H×W×3).
    Mapbox terrain-RGB:  height = -10000 + (R*65536 + G*256 + B) * 0.1
    """
    value = np.round((elev + 10000) / 0.1).astype(np.int64)
    value = np.clip(value, 0, 2**24 - 1)
    return np.stack([
        ((value >> 16) & 0xFF).astype(np.uint8),
        ((value >>  8) & 0xFF).astype(np.uint8),
        ( value        & 0xFF).astype(np.uint8),
    ], axis=-1)


def fill_nodata(data: np.ndarray) -> np.ndarray:
    """Replace NaN values with the nearest valid pixel (in-place safe)."""
    valid = ~np.isnan(data)
    if valid.all() or not valid.any():
        return data
    _, idx = distance_transform_edt(~valid, return_indices=True)
    out = data.copy()
    out[~valid] = data[idx[0][~valid], idx[1][~valid]]
    return out


# ---------------------------------------------------------------------------
# Tile generation
# ---------------------------------------------------------------------------

def generate_tile(src: rasterio.DatasetReader,
                  tx: int, ty: int, z: int,
                  out_dir: Path) -> bool:
    """Reproject one tile from src and write terrain-RGB PNG. Returns True if written."""
    west, south, east, north = tile_bounds_3857(tx, ty, z)
    pixel_m    = (east - west) / TILE_SIZE
    dst_transform = Affine(pixel_m, 0, west, 0, -pixel_m, north)

    dst_data = np.full((TILE_SIZE, TILE_SIZE), np.nan, dtype=np.float32)

    reproject(
        source=rasterio.band(src, 1),
        destination=dst_data,
        src_transform=src.transform,
        src_crs=src.crs,
        dst_transform=dst_transform,
        dst_crs=WEB_MERC,
        resampling=Resampling.bilinear,
        src_nodata=src.nodata,
        dst_nodata=np.nan,
    )

    if not np.any(~np.isnan(dst_data)):
        return False   # tile is entirely outside the DTM — skip

    dst_data = fill_nodata(dst_data)
    rgb = encode_terrain_rgb(dst_data)

    tile_path = out_dir / str(z) / str(tx) / f"{ty}.png"
    tile_path.parent.mkdir(parents=True, exist_ok=True)
    # compress_level=1: fast write, tiny files; terrain data compresses poorly anyway
    Image.fromarray(rgb, "RGB").save(tile_path, compress_level=1)
    return True


def _tile_worker(args: tuple) -> bool:
    """Top-level function so ProcessPoolExecutor can pickle it.
    Each worker opens its own handle to avoid sharing rasterio datasets across processes."""
    dtm_path, tx, ty, z, out_dir = args
    with rasterio.open(dtm_path) as src:
        return generate_tile(src, tx, ty, z, Path(out_dir))


def generate_tiles(dtm_path: str | Path, out_dir: Path,
                   zoom_min: int = 12, zoom_max: int = 15,
                   bbox_3006: tuple[float, float, float, float] | None = None) -> None:
    dtm_path = str(dtm_path)
    out_dir  = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with rasterio.open(dtm_path) as src:
        bounds_wgs84 = transform_bounds(src.crs, WGS84, *src.bounds)
        print(f"Source CRS   : {src.crs}")
        print(f"Nodata       : {src.nodata}")

    if bbox_3006 is not None:
        bbox_wgs84 = transform_bounds(CRS.from_epsg(3006), WGS84, *bbox_3006)
        bounds_wgs84 = (
            max(bounds_wgs84[0], bbox_wgs84[0]),
            max(bounds_wgs84[1], bbox_wgs84[1]),
            min(bounds_wgs84[2], bbox_wgs84[2]),
            min(bounds_wgs84[3], bbox_wgs84[3]),
        )
        print(f"bbox         : EPSG:3006 {bbox_3006}")

    west, south, east, north = bounds_wgs84
    print(f"Bounds WGS84 : {west:.4f}°E  {south:.4f}°N  {east:.4f}°E  {north:.4f}°N")
    print()

    # os.cpu_count() workers each hold their own GDAL handle/cache against the
    # source DTM; on a 24-thread machine that can exceed available RAM and
    # trigger the OOM killer (see generate_overlay_tiles.py for the same fix).
    workers = min(os.cpu_count() or 4, 8)
    print(f"Using {workers} parallel workers\n")

    total_written = 0

    for z in range(zoom_min, zoom_max + 1):
        tile_list = [(dtm_path, tx, ty, z, str(out_dir))
                     for tx, ty in tiles_for_bounds(west, south, east, north, z)]
        written = 0

        print(f"Z{z:02d}  {len(tile_list)} candidate tiles", end="", flush=True)

        with ProcessPoolExecutor(max_workers=workers) as pool:
            for i, result in enumerate(pool.map(_tile_worker, tile_list, chunksize=16)):
                if result:
                    written += 1
                if (i + 1) % 200 == 0:
                    print(f"\n      {i+1}/{len(tile_list)} ({written} written)", end="", flush=True)

        print(f"\n      → {written} tiles written")
        total_written += written

    write_coverage_geojson(bounds_wgs84, out_dir)
    print(f"\nDone. {total_written} tiles total in {out_dir}")


def write_coverage_geojson(bounds_wgs84: tuple, out_dir: Path) -> None:
    """Write coverage.geojson with two features:
    - 'mask'  : inverted polygon (world minus coverage) for the grey-out fill
    - 'border': coverage rectangle for the dashed boundary line
    """
    west, south, east, north = bounds_wgs84
    geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"type": "mask"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        # outer ring: whole world (CCW)
                        [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]],
                        # inner ring: coverage area as hole (CW = punches a window)
                        [[west, south], [west, north], [east, north], [east, south], [west, south]],
                    ],
                },
            },
            {
                "type": "Feature",
                "properties": {"type": "border"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [west, south], [east, south],
                        [east, north], [west, north], [west, south],
                    ]],
                },
            },
        ],
    }
    path = out_dir / "coverage.geojson"
    path.write_text(json.dumps(geojson))
    print(f"Coverage extent : {path}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dtm",     nargs="?", default=DTM_PATH,
                        help="Input DTM GeoTIFF (default: %(default)s)")
    parser.add_argument("out_dir", nargs="?", default=str(OUT_DIR),
                        help="Output tile directory (default: %(default)s)")
    parser.add_argument("--zoom",  nargs=2, type=int, default=[12, 15],
                        metavar=("MIN", "MAX"),
                        help="Zoom range (default: 12 15)")
    parser.add_argument("--bbox", nargs=4, type=float, default=None,
                        metavar=("MINX", "MINY", "MAXX", "MAXY"),
                        help="Bounding box in SWEREF99TM / EPSG:3006 to further "
                             "restrict output extent (e.g. for a small test region)")
    args = parser.parse_args()

    bbox_3006 = tuple(args.bbox) if args.bbox else None
    generate_tiles(args.dtm, Path(args.out_dir), *args.zoom, bbox_3006=bbox_3006)
