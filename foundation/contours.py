#!/usr/bin/env python3
"""
Contour lines from the merged LiDAR DTM.

Pipeline per chunk (chunks run in parallel, each read with an overlap margin so
results are seam-free):

  1. Read the DTM window (+ overlap) from the merged VRT
  2. NaN-aware Gaussian pre-smooth — raw 1 m LiDAR contours are jagged with
     ground-point noise; sigma of a few metres gives clean, map-like lines.
     NaN-aware (normalized convolution) so no-data gaps (lakes, missing tiles)
     don't bleed into their surroundings; pixels that are mostly no-data after
     smoothing stay no-data, so no contours are invented there.
  3. Trace with gdal_contour (CLI — the GDAL Python bindings aren't installed)
  4. Clip to the chunk's core box, Douglas-Peucker simplify, Chaikin smooth
     (endpoints pinned, so the pieces from neighbouring chunks still meet
     exactly at the shared boundary), drop tiny closed noise rings

Then all pieces are line-merged per elevation across chunk seams and written as:

  <name>.geojson  — WGS84 FeatureCollection, properties {ele, level}
  <name>.pmtiles  — vector tiles (layer "contours"), via tippecanoe

`level` is the coarsest tier a line belongs to (100 / 25 / 5 for the default 5 m
interval), for styling index contours. In the PMTiles (layer "contours"),
levels appear by zoom: 100 m from z10, 25 m from z12, everything from z14 (--tiers;
--tiers 100:10,25:10,5:10 keeps every line at every zoom, leaving thinning to the style).

Everything is written to local disk (default ~/lidar-output/contours): large
writes straight to the /mnt/g mount have produced truncated files before (see
mtb-editor/CLAUDE.md / the dalarna.pmtiles incident).

With --stream (large areas), each chunk's lines are appended to <name>.geojsonl
(newline-delimited GeoJSON) as soon as they're done instead of being held in memory
and merged; lines then stay split at chunk boundaries.

Usage (SWEREF99TM bbox: xmin ymin xmax ymax):
    python contours.py --bbox 525000 6712000 545000 6732000 --name contours_falun
    python contours.py --stream --name contours_dalarna          # whole DTM extent
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy.ndimage import gaussian_filter
import pyogrio
import shapely
from shapely.geometry import box
from pyproj import Transformer

from log_utils import log, Progress

DEFAULT_DTM = Path.home() / "lidar-output/dtm/merged_dtm.vrt"
DEFAULT_OUT = Path.home() / "lidar-output/contours"
NODATA = -9999.0
PMTILES_MINZOOM = 10
DEFAULT_TIERS = "100:10,25:12,5:14"   # level:first zoom it's written into the tiles


def nan_gaussian(a: np.ndarray, sigma_px: float, min_weight: float = 0.5) -> np.ndarray:
    """Gaussian blur that ignores NaN (normalized convolution)."""
    valid = np.isfinite(a)
    filled = np.where(valid, a, 0.0).astype(np.float32)
    w = gaussian_filter(valid.astype(np.float32), sigma_px, mode="nearest")
    v = gaussian_filter(filled, sigma_px, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        out = v / w
    out[w < min_weight] = np.nan
    return out


def chaikin(coords: np.ndarray, iterations: int, closed: bool) -> np.ndarray:
    """Chaikin corner cutting. Open lines keep their exact endpoints."""
    for _ in range(iterations):
        if len(coords) < 3:
            return coords
        if closed:
            pts = coords[:-1]                       # drop duplicate closing point
            nxt = np.roll(pts, -1, axis=0)
            q = 0.75 * pts + 0.25 * nxt
            r = 0.25 * pts + 0.75 * nxt
            out = np.empty((len(pts) * 2, 2))
            out[0::2], out[1::2] = q, r
            coords = np.vstack([out, out[:1]])
        else:
            a, b = coords[:-1], coords[1:]
            q = 0.75 * a + 0.25 * b
            r = 0.25 * a + 0.75 * b
            mid = np.empty((len(a) * 2, 2))
            mid[0::2], mid[1::2] = q, r
            coords = np.vstack([coords[:1], mid[1:-1], coords[-1:]])
    return coords


def level_for(ele: float, interval: float) -> int:
    for lv in (100, 25):
        if lv > interval and round(ele) % lv == 0:
            return lv
    return int(interval)


_TO_WGS = None


def feature_json(ele: float, coords_3006: np.ndarray, interval: float) -> tuple[str, int]:
    """One GeoJSON Feature (WGS84, 6 decimals ≈ 10 cm) as a compact JSON string."""
    global _TO_WGS
    if _TO_WGS is None:
        _TO_WGS = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True)
    lon, lat = _TO_WGS.transform(coords_3006[:, 0], coords_3006[:, 1])
    coords = np.round(np.column_stack([lon, lat]), 6).tolist()
    feat = {"type": "Feature", "properties": {"ele": int(round(ele)), "level": level_for(ele, interval)},
            "geometry": {"type": "LineString", "coordinates": coords}}
    return json.dumps(feat, separators=(",", ":")), len(coords)


def process_chunk(args) -> list:
    """Returns [(ele, coords_3006), ...], or with stream=True [(ele, feature_json, n_vertices), ...]
    — serialising in the worker keeps the main process to plain file appends."""
    (dtm, core, overlap, interval, sigma_m, simplify_m, chaikin_iter, min_ring_m, tmpdir, stream) = args
    xmin, ymin, xmax, ymax = core
    with rasterio.open(dtm) as src:
        win = from_bounds(xmin - overlap, ymin - overlap, xmax + overlap, ymax + overlap, src.transform)
        win = win.round_offsets().round_lengths()
        data = src.read(1, window=win, boundless=True, fill_value=np.nan).astype(np.float32)
        transform = src.window_transform(win)
        crs = src.crs or "EPSG:3006"
        px = abs(src.res[0])
        nodata = src.nodata
    if nodata is not None and not math.isnan(nodata):
        data[data == nodata] = np.nan
    if not np.isfinite(data).any():
        return []

    smooth = nan_gaussian(data, sigma_m / px)
    smooth = np.where(np.isfinite(smooth), smooth, NODATA).astype(np.float32)

    tag = f"{int(xmin)}_{int(ymin)}"
    tif = os.path.join(tmpdir, f"dtm_{tag}.tif")
    gpkg = os.path.join(tmpdir, f"contours_{tag}.gpkg")
    with rasterio.open(tif, "w", driver="GTiff", width=smooth.shape[1], height=smooth.shape[0],
                       count=1, dtype="float32", crs=crs, transform=transform, nodata=NODATA) as dst:
        dst.write(smooth, 1)
    subprocess.run(["gdal_contour", "-q", "-i", str(interval), "-a", "ele", "-snodata", str(NODATA),
                    "-f", "GPKG", tif, gpkg], check=True,
                   stdout=subprocess.DEVNULL)   # -q doesn't silence its progress dots
    geoms_df = pyogrio.read_dataframe(gpkg)
    os.remove(tif)
    os.remove(gpkg)

    core_box = box(xmin, ymin, xmax, ymax)
    out = []
    for ele, geom in zip(geoms_df["ele"].to_numpy(), geoms_df.geometry.to_numpy()):
        clipped = shapely.intersection(geom, core_box)
        if clipped.is_empty:
            continue
        for part in shapely.get_parts(shapely.line_merge(clipped) if clipped.geom_type == "MultiLineString" else clipped):
            if part.geom_type != "LineString" or part.length == 0:
                continue
            closed = part.is_ring
            if closed and part.length < min_ring_m:
                continue                              # tiny noise ring
            simp = shapely.simplify(part, simplify_m, preserve_topology=False)
            coords = chaikin(np.asarray(simp.coords), chaikin_iter, closed)
            if len(coords) >= 2:
                if stream:
                    js, n = feature_json(float(ele), coords, interval)
                    out.append((float(ele), js, n))
                else:
                    out.append((float(ele), coords))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                    help="area in SWEREF99TM (EPSG:3006) metres (default: the DTM's full extent)")
    ap.add_argument("--name", default="contours", help="output basename")
    ap.add_argument("--dtm", default=str(DEFAULT_DTM))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--interval", type=float, default=5.0, help="contour interval, m (default 5)")
    ap.add_argument("--sigma", type=float, default=3.0, help="Gaussian pre-smooth sigma, m (default 3)")
    ap.add_argument("--simplify", type=float, default=0.5, help="Douglas-Peucker tolerance, m (default 0.5)")
    ap.add_argument("--chaikin", type=int, default=2, help="Chaikin smoothing iterations (default 2)")
    ap.add_argument("--min-ring", type=float, default=40.0, help="drop closed rings shorter than this, m")
    ap.add_argument("--chunk", type=float, default=5000.0, help="chunk size, m (default 5000)")
    ap.add_argument("--overlap", type=float, default=100.0, help="chunk read margin, m (default 100)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument("--tiers", default=DEFAULT_TIERS,
                    help="PMTiles thinning, level:minzoom pairs (default %(default)s). Lines of a "
                         "level are left out of tiles below that zoom. Use e.g. 100:10,25:10,5:10 "
                         "to keep every line in every tile and do the thinning in the map style")
    ap.add_argument("--no-pmtiles", action="store_true", help="skip the tippecanoe step")
    ap.add_argument("--stream", action="store_true",
                    help="for large areas (e.g. all of Dalarna): write each chunk's lines as soon as it's "
                         "done, to <name>.geojsonl (one Feature per line), instead of holding everything "
                         "in memory. Lines then stay split at chunk boundaries (invisible when drawn)")
    args = ap.parse_args()

    if args.overlap < 4 * args.sigma:
        sys.exit("--overlap must be at least 4x --sigma, or chunk seams won't match")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.bbox:
        xmin, ymin, xmax, ymax = args.bbox
    else:
        with rasterio.open(args.dtm) as src:
            xmin, ymin, xmax, ymax = src.bounds

    cores = []
    y = ymin
    while y < ymax:
        x = xmin
        while x < xmax:
            cores.append((x, y, min(x + args.chunk, xmax), min(y + args.chunk, ymax)))
            x += args.chunk
        y += args.chunk

    log(f"Contours every {args.interval:g} m over {(xmax - xmin) / 1000:g} x {(ymax - ymin) / 1000:g} km "
        f"({len(cores)} chunks, sigma {args.sigma:g} m, {args.workers} workers)")
    tmpdir = tempfile.mkdtemp(prefix="contours_", dir=out_dir)
    jobs = [(args.dtm, c, args.overlap, args.interval, args.sigma, args.simplify, args.chaikin,
             args.min_ring, tmpdir, args.stream) for c in cores]
    pieces = {}                      # in-memory mode: ele -> [coords_3006, ...]
    n_lines = n_vertices = 0
    ele_min, ele_max = math.inf, -math.inf
    failed = []
    out_path = out_dir / (f"{args.name}.geojsonl" if args.stream else f"{args.name}.geojson")
    # Streamed output goes to a .partial name, renamed only once complete, so an
    # interrupted run can never be mistaken for a finished file.
    partial = out_path.with_name(out_path.name + ".partial")
    stream_f = open(partial, "w") if args.stream else None
    try:
        progress = Progress(len(jobs))
        with ProcessPoolExecutor(max_workers=args.workers) as ex:
            futures = {ex.submit(process_chunk, j): j[1] for j in jobs}
            for i, fut in enumerate(as_completed(futures)):
                try:
                    result = fut.result()
                except Exception as e:           # keep going; report at the end
                    failed.append((futures[fut], repr(e)))
                    result = []
                for item in result:
                    ele = item[0]
                    ele_min, ele_max = min(ele_min, ele), max(ele_max, ele)
                    if args.stream:
                        stream_f.write(item[1] + "\n")
                        n_lines += 1
                        n_vertices += item[2]
                    else:
                        pieces.setdefault(ele, []).append(item[1])
                progress.update(i + 1, f"({n_lines} lines)" if args.stream else "")
        progress.done()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        if stream_f:
            stream_f.close()

    if failed:
        for core, err in failed:
            log(f"FAILED chunk {core}: {err}")
        if args.stream:
            sys.exit(f"{len(failed)} chunk(s) failed — output left at {partial}, not finalised. "
                     "Re-run (or re-run just those chunks via --bbox) before using it.")
        sys.exit(f"{len(failed)} chunk(s) failed — nothing written.")

    if args.stream:
        partial.rename(out_path)
    else:
        # Re-join pieces cut at chunk boundaries.
        log("Merging lines across chunk seams")
        features = []
        for ele in sorted(pieces):
            merged = shapely.line_merge(shapely.multilinestrings([shapely.linestrings(c) for c in pieces[ele]]))
            for line in shapely.get_parts(merged):
                js, n = feature_json(ele, np.asarray(line.coords), args.interval)
                features.append(js)
                n_vertices += n
        n_lines = len(features)
        with open(out_path, "w") as f:
            f.write('{"type":"FeatureCollection","features":[')
            f.write(",".join(features))
            f.write("]}")
    log(f"{n_lines} lines, {n_vertices} vertices, elevations "
        + (f"{ele_min}–{ele_max} m" if n_lines else "-"))
    log(f"Written: {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")

    if args.no_pmtiles:
        return
    # Zoom tiers via a layer filter, NOT a per-feature "tippecanoe": {"minzoom"}
    # key: with tippecanoe 2.49 that key made it silently drop most lines from
    # tiles (12 lines in, 1 out, even with a no-op minzoom) — verified on the
    # Falun run, see foundation/CLAUDE.md.
    tiers = {int(k): int(v) for k, v in (t.split(":") for t in args.tiers.split(","))}
    fine_minzoom = tiers.get(int(args.interval), max(tiers.values()))
    tier_filter = json.dumps({"contours": ["any",
        [">=", "$zoom", fine_minzoom],
        *[["all", [">=", "$zoom", mz], ["==", "level", lv]] for lv, mz in tiers.items() if lv != int(args.interval)]]})
    pmtiles_path = out_dir / f"{args.name}.pmtiles"
    log("Packing PMTiles with tippecanoe")
    subprocess.run(["tippecanoe", f"--output={pmtiles_path}", "--force", "-q",
                    f"--minimum-zoom={PMTILES_MINZOOM}", "--maximum-zoom=16", "--layer=contours",
                    "--no-feature-limit", "--no-tile-size-limit", "-j", tier_filter,
                    *(["--read-parallel"] if args.stream else []),   # needs one Feature per line
                    "-t", str(out_dir),                                # temp files on local disk
                    str(out_path)], check=True)
    log(f"Written: {pmtiles_path} ({pmtiles_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
