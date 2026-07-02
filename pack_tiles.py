#!/usr/bin/env python3
"""
Pack a z/x/y.png tile directory into a single PMTiles archive.

Requires go-pmtiles CLI for the final conversion step.
Install (one-time):
    wget -qO- https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_Linux_x86_64.tar.gz \
      | tar xz pmtiles && mv pmtiles ~/.local/bin/

Usage:
    python pack_tiles.py viewer/tiles terrain.pmtiles
    python pack_tiles.py viewer/tiles terrain.pmtiles --name terrain --keep-mbtiles

Notes:
    Tile reads are parallelised, since reading millions of small files one at a time
    on a slow network-backed mount (e.g. WSL's /mnt/* drives) pays a per-file round
    trip and can turn a job into a 12-hour crawl. tile_dir should live on fast local
    storage for this reason.

    The intermediate .mbtiles is a different story: it's one growing file, not
    millions of small ones, so it doesn't pay that per-file penalty on a /mnt/* mount.
    It's staged under STAGE_ROOT (default /mnt/g/lidar-output/.pack_tiles_tmp) rather
    than the local WSL disk, because the .mbtiles alone can approach the size of all
    tile bytes combined — building it locally alongside other multi-hundred-GB
    intermediates (DTM/CHM mosaics, raw tile trees) has been enough to fill the 1TB
    WSL virtual disk mid-run. Override with --stage-dir if /mnt/g isn't available.
"""

import argparse
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from log_utils import log, Progress

READ_WORKERS = 24
CHUNK_SIZE = 20_000
STAGE_ROOT = Path("/mnt/g/lidar-output/.pack_tiles_tmp")


def list_tiles(tile_dir: Path):
    """Return (zoom_levels, [(z, x, y_xyz, path), ...]).

    Only lists directories/globs filenames — never opens a file — so this stays
    fast even on slow mounts. The expensive part is reading file contents, which
    dir_to_mbtiles parallelises separately.
    """
    zoom_levels = sorted(
        int(p.name) for p in tile_dir.iterdir() if p.is_dir() and p.name.isdigit()
    )
    tiles = []
    for z in zoom_levels:
        for x_dir in (tile_dir / str(z)).iterdir():
            if not x_dir.is_dir():
                continue
            x = int(x_dir.name)
            for tile_file in x_dir.glob('*.png'):
                tiles.append((z, x, int(tile_file.stem), tile_file))
    return zoom_levels, tiles


def dir_to_mbtiles(tile_dir: Path, mbtiles_path: Path, name: str) -> int:
    conn = sqlite3.connect(mbtiles_path)
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT, PRIMARY KEY (name));
        CREATE TABLE IF NOT EXISTS tiles (
            zoom_level  INTEGER,
            tile_column INTEGER,
            tile_row    INTEGER,
            tile_data   BLOB,
            PRIMARY KEY (zoom_level, tile_column, tile_row)
        );
    """)

    log("  Listing tiles...")
    zoom_levels, tiles = list_tiles(tile_dir)
    if not zoom_levels:
        log("ERROR: no zoom-level directories found")
        sys.exit(1)
    total = len(tiles)

    c.executemany("INSERT OR REPLACE INTO metadata VALUES (?, ?)", [
        ('name',        name),
        ('format',      'png'),
        ('type',        'overlay'),
        ('description', 'Terrain RGB elevation tiles — Lantmäteriet LiDAR'),
        ('version',     '1'),
        ('minzoom',     str(min(zoom_levels))),
        ('maxzoom',     str(max(zoom_levels))),
    ])

    def read_tile(item):
        z, x, y_xyz, path = item
        return z, x, y_xyz, path.read_bytes()

    count = 0
    progress = Progress(total)
    with ThreadPoolExecutor(max_workers=READ_WORKERS) as pool:
        for start in range(0, total, CHUNK_SIZE):
            chunk = tiles[start:start + CHUNK_SIZE]
            for z, x, y_xyz, data in pool.map(read_tile, chunk):
                y_tms = (1 << z) - 1 - y_xyz
                c.execute(
                    "INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)",
                    (z, x, y_tms, sqlite3.Binary(data)),
                )
                count += 1
                if count % 2000 == 0:
                    progress.update(count, "tiles written")
            conn.commit()
    progress.done()

    c.execute("CREATE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row)")
    conn.commit()
    conn.close()
    log(f"  {count:,} tiles → {mbtiles_path} ({mbtiles_path.stat().st_size / 1e9:.2f} GB)")
    return count


def mbtiles_to_pmtiles(mbtiles: Path, output: Path) -> None:
    if output.exists():
        output.unlink()
    try:
        result = subprocess.run(
            ['pmtiles', 'convert', str(mbtiles), str(output)],
            check=True, text=True, capture_output=True,
        )
        if result.stdout:
            log(result.stdout.strip())
    except FileNotFoundError:
        log("ERROR: 'pmtiles' CLI not found. Install it with:")
        log("  wget -qO- https://github.com/protomaps/go-pmtiles/releases/download/v1.30.3/"
            "go-pmtiles_1.30.3_Linux_x86_64.tar.gz | tar xz pmtiles && mv pmtiles ~/.local/bin/")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        log(f"ERROR: pmtiles convert failed:\n{e.stderr}")
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description='Pack z/x/y tile dir into a PMTiles archive')
    ap.add_argument('tile_dir', help='Directory containing z/x/y.png tiles')
    ap.add_argument('output',   help='Output .pmtiles file path')
    ap.add_argument('--name',         default='terrain', help='Tileset name (default: terrain)')
    ap.add_argument('--keep-mbtiles', action='store_true', help='Keep intermediate .mbtiles file')
    ap.add_argument('--stage-dir', default=None,
                    help=f'Where to build the intermediate .mbtiles (default: {STAGE_ROOT}). '
                         'Should have room for roughly the total size of tile_dir.')
    args = ap.parse_args()

    tile_dir = Path(args.tile_dir)
    output   = Path(args.output)

    if not tile_dir.is_dir():
        log(f"ERROR: {tile_dir} is not a directory")
        sys.exit(1)

    stage_root = Path(args.stage_dir) if args.stage_dir else STAGE_ROOT
    stage_root.mkdir(parents=True, exist_ok=True)
    stage_dir = Path(tempfile.mkdtemp(prefix="pack_tiles_", dir=stage_root))
    mbtiles = stage_dir / (output.stem + ".mbtiles")
    staged_output = stage_dir / output.name

    try:
        log(f"Step 1/2  Building MBTiles from {tile_dir}/  (staging in {stage_dir})")
        dir_to_mbtiles(tile_dir, mbtiles, args.name)

        log(f"Step 2/2  Converting MBTiles → PMTiles")
        mbtiles_to_pmtiles(mbtiles, staged_output)

        output.parent.mkdir(parents=True, exist_ok=True)
        log(f"  Moving to {output}")
        shutil.move(str(staged_output), str(output))

        if args.keep_mbtiles:
            kept = output.with_suffix('.mbtiles')
            shutil.move(str(mbtiles), str(kept))
            log(f"  Kept intermediate: {kept}")
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)

    size_mb = output.stat().st_size / 1e6
    log(f"Done: {output}  ({size_mb:.0f} MB)")

if __name__ == '__main__':
    main()
