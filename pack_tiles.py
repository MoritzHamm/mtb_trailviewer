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
"""

import argparse
import sqlite3
import subprocess
import sys
from pathlib import Path

from log_utils import log, Progress


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

    zoom_levels = sorted(
        int(p.name) for p in tile_dir.iterdir()
        if p.is_dir() and p.name.isdigit()
    )
    if not zoom_levels:
        log("ERROR: no zoom-level directories found")
        sys.exit(1)

    c.executemany("INSERT OR REPLACE INTO metadata VALUES (?, ?)", [
        ('name',        name),
        ('format',      'png'),
        ('type',        'overlay'),
        ('description', 'Terrain RGB elevation tiles — Lantmäteriet LiDAR'),
        ('version',     '1'),
        ('minzoom',     str(min(zoom_levels))),
        ('maxzoom',     str(max(zoom_levels))),
    ])

    log("  Counting tiles...")
    total = sum(1 for z in zoom_levels
                for x_dir in (tile_dir / str(z)).iterdir() if x_dir.is_dir()
                for _ in x_dir.glob('*.png'))

    count = 0
    progress = Progress(total)
    for z in zoom_levels:
        z_dir = tile_dir / str(z)
        for x_dir in z_dir.iterdir():
            if not x_dir.is_dir():
                continue
            x = int(x_dir.name)
            for tile_file in x_dir.glob('*.png'):
                y_xyz = int(tile_file.stem)
                # MBTiles uses TMS y (origin at bottom); XYZ has origin at top
                y_tms = (1 << z) - 1 - y_xyz
                c.execute(
                    "INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)",
                    (z, x, y_tms, sqlite3.Binary(tile_file.read_bytes())),
                )
                count += 1
                if count % 2000 == 0:
                    conn.commit()
                    progress.update(count, "tiles written")
    progress.done()

    conn.commit()
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
    args = ap.parse_args()

    tile_dir = Path(args.tile_dir)
    output   = Path(args.output)
    mbtiles  = output.with_suffix('.mbtiles')

    if not tile_dir.is_dir():
        log(f"ERROR: {tile_dir} is not a directory")
        sys.exit(1)

    log(f"Step 1/2  Building MBTiles from {tile_dir}/")
    dir_to_mbtiles(tile_dir, mbtiles, args.name)

    log(f"Step 2/2  Converting MBTiles → PMTiles")
    mbtiles_to_pmtiles(mbtiles, output)

    if not args.keep_mbtiles:
        mbtiles.unlink()

    size_mb = output.stat().st_size / 1e6
    log(f"Done: {output}  ({size_mb:.0f} MB)")

if __name__ == '__main__':
    main()
