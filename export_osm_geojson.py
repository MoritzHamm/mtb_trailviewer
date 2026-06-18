#!/usr/bin/env python3
"""
Export OSM GeoPackage → WGS84 GeoJSON for the terrain viewer.

Usage:
    python export_osm_geojson.py [input.gpkg] [output.geojson]
"""

import sys
from pathlib import Path

import geopandas as gpd

GPKG_DEFAULT = Path("/mnt/g/lidar-output/osm_raw.gpkg")
OUT_DEFAULT  = Path(__file__).parent / "viewer" / "tiles" / "osm.geojson"

KEEP_HIGHWAY = {
    "primary", "secondary", "tertiary", "residential", "unclassified",
    "service", "track", "path", "footway", "cycleway", "bridleway",
}
KEEP_WATERWAY = {"stream", "river", "canal", "ditch"}

KEEP_COLS = [
    "osm_id", "highway", "waterway", "name",
    "surface", "mtb:scale", "mtb:scale:imba", "tracktype",
    "geometry",
]

def main() -> None:
    gpkg = Path(sys.argv[1]) if len(sys.argv) > 1 else GPKG_DEFAULT
    out  = Path(sys.argv[2]) if len(sys.argv) > 2 else OUT_DEFAULT

    print(f"Reading {gpkg} …")
    gdf = gpd.read_file(gpkg)

    road_mask  = gdf["highway"].isin(KEEP_HIGHWAY)
    water_mask = gdf["waterway"].isin(KEEP_WATERWAY) if "waterway" in gdf.columns else False
    gdf = gdf[road_mask | water_mask].copy()

    cols = [c for c in KEEP_COLS if c in gdf.columns]
    gdf = gdf[cols]

    gdf = gdf.to_crs("EPSG:4326")

    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    print(f"Wrote {len(gdf)} features → {out}")

    hw = gdf["highway"].value_counts()
    print(hw.to_string())
    if "waterway" in gdf.columns:
        print(gdf["waterway"].value_counts().to_string())

if __name__ == "__main__":
    main()
