#!/usr/bin/env python3
"""
Extract OSM polygon features from a PBF → categorised WGS84 GeoJSON files.

Uses ogr2ogr (GDAL OSM driver) which correctly assembles multipolygon relations.
One ogr2ogr pass dumps everything to a temp GeoPackage; Python then splits by category.

Output:
  water.geojson    — lakes, ponds, reservoirs, wetlands (natural=water/wetland)
  landuse.geojson  — forest, farmland, meadow, heath, scrub …
  buildings.geojson — all building footprints

Usage:
    python extract_osm_polygons.py \\
        --bbox 342500 6630000 600000 6900000 \\
        --pbf  /mnt/g/Download/sweden-latest.osm.pbf \\
        --out  /mnt/g/lidar-output/osm_layers
"""

import argparse
import subprocess
import tempfile
from pathlib import Path

import geopandas as gpd
from pyproj import Transformer

PBF_DEFAULT  = "/mnt/g/Download/sweden-latest.osm.pbf"
OUT_DEFAULT  = Path("/mnt/g/lidar-output/osm_layers")
BBOX_DEFAULT = (342500, 6630000, 600000, 6900000)

WATER_NATURAL  = {"water", "wetland", "bay", "strait", "lake"}
WATER_LANDUSE  = {"reservoir", "basin"}
LANDUSE_TYPES  = {"forest", "farmland", "meadow", "orchard", "vineyard",
                  "allotments", "cemetery", "commercial", "industrial",
                  "residential", "retail", "military", "quarry", "landfill"}
NATURAL_LANDCOVER = {"wood", "scrub", "heath", "grassland", "fell",
                     "glacier", "mud", "sand", "beach", "wetland"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bbox", nargs=4, type=float,
                        metavar=("MINX", "MINY", "MAXX", "MAXY"),
                        default=BBOX_DEFAULT)
    parser.add_argument("--pbf", default=PBF_DEFAULT)
    parser.add_argument("--out", default=str(OUT_DEFAULT))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    minx, miny, maxx, maxy = args.bbox
    t = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True)
    minlon, minlat = t.transform(minx, miny)
    maxlon, maxlat = t.transform(maxx, maxy)
    spat = f"{minlon} {minlat} {maxlon} {maxlat}"

    with tempfile.TemporaryDirectory() as tmp:
        gpkg = Path(tmp) / "polys.gpkg"

        print("Running ogr2ogr to extract multipolygons …")
        cmd = [
            "ogr2ogr",
            "-f", "GPKG", str(gpkg),
            args.pbf,
            "multipolygons",
            "-spat", *spat.split(),
            "-t_srs", "EPSG:4326",
            "-nlt", "PROMOTE_TO_MULTI",
        ]
        subprocess.run(cmd, check=True)

        print("Loading and categorising …")
        gdf = gpd.read_file(gpkg)
        print(f"  Total multipolygons in bbox: {len(gdf)}")

        nat  = gdf.get("natural",  gpd.pd.Series(dtype=str)).fillna("")
        lu   = gdf.get("landuse",  gpd.pd.Series(dtype=str)).fillna("")
        bld  = gdf.get("building", gpd.pd.Series(dtype=str)).fillna("")

        water_mask    = nat.isin(WATER_NATURAL) | lu.isin(WATER_LANDUSE)
        landuse_mask  = lu.isin(LANDUSE_TYPES) | nat.isin(NATURAL_LANDCOVER)
        building_mask = bld != ""

        def write(mask, name: str) -> None:
            sub = gdf[mask].copy()
            if sub.empty:
                print(f"  {name}: 0 features — skipped")
                return
            sub.to_file(out / f"{name}.geojson", driver="GeoJSON")
            print(f"  {name}: {len(sub)}")

        write(water_mask,    "water")
        write(landuse_mask,  "landuse")
        write(building_mask, "buildings")

    print("\nPolygon layers done.")


if __name__ == "__main__":
    main()
