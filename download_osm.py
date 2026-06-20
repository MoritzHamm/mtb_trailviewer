#!/usr/bin/env python3
"""
Extract OSM highway + waterway features from a local PBF file.

Bounding box is given in SWEREF99TM (EPSG:3006); converted internally to WGS84.

Usage:
    # Single test tile
    python download_osm.py

    # Full LiDAR coverage (Dalarna)
    python download_osm.py \
        --bbox 342500 6630000 600000 6900000 \
        --out /mnt/g/lidar-output/osm_dalarna.gpkg
"""

import argparse
import osmium
import geopandas as gpd
from shapely.geometry import LineString
from pyproj import Transformer

PBF_FILE    = "/mnt/g/Download/sweden-latest.osm.pbf"
OUT_GPKG    = "/mnt/g/lidar-output/osm_raw.gpkg"

# Default: single dev tile + 200 m padding
DEFAULT_BBOX = (530000 - 200, 6720000 - 200, 532500 + 200, 6722500 + 200)


class WayHandler(osmium.SimpleHandler):
    def __init__(self, minlat, maxlat, minlon, maxlon):
        super().__init__()
        self.minlat, self.maxlat = minlat, maxlat
        self.minlon, self.maxlon = minlon, maxlon
        self.ways  = []
        self.nodes = {}

    def node(self, n):
        margin = 0.01
        if (self.minlat - margin <= n.location.lat <= self.maxlat + margin and
                self.minlon - margin <= n.location.lon <= self.maxlon + margin):
            self.nodes[n.id] = (n.location.lon, n.location.lat)

    def way(self, w):
        tags = dict(w.tags)
        if "highway" not in tags and "waterway" not in tags:
            return
        try:
            coords = [self.nodes[n.ref] for n in w.nodes if n.ref in self.nodes]
            if len(coords) < 2:
                return
            lons = [c[0] for c in coords]
            lats = [c[1] for c in coords]
            if (max(lons) < self.minlon or min(lons) > self.maxlon or
                    max(lats) < self.minlat or min(lats) > self.maxlat):
                return
            row = {"geometry": LineString(coords), "osm_id": w.id}
            row.update(tags)
            self.ways.append(row)
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bbox", nargs=4, type=float,
                        metavar=("MINX", "MINY", "MAXX", "MAXY"),
                        default=DEFAULT_BBOX,
                        help="Bounding box in SWEREF99TM / EPSG:3006 (default: dev tile)")
    parser.add_argument("--pbf", default=PBF_FILE, help="Input OSM PBF file")
    parser.add_argument("--out", default=OUT_GPKG, help="Output GeoPackage path")
    args = parser.parse_args()

    minx, miny, maxx, maxy = args.bbox

    t = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True)
    minlon, minlat = t.transform(minx, miny)
    maxlon, maxlat = t.transform(maxx, maxy)

    print(f"Bounding box (SWEREF99TM): E {minx:.0f}–{maxx:.0f}  N {miny:.0f}–{maxy:.0f}")
    print(f"Bounding box (WGS84):      lon {minlon:.4f}–{maxlon:.4f}  lat {minlat:.4f}–{maxlat:.4f}")
    print(f"PBF: {args.pbf}")
    print(f"Out: {args.out}")
    print()

    print("Streaming PBF …")
    handler = WayHandler(minlat, maxlat, minlon, maxlon)
    handler.apply_file(args.pbf, locations=True)
    print(f"  Ways found: {len(handler.ways)}")

    gdf = gpd.GeoDataFrame(handler.ways, crs="EPSG:4326")
    gdf = gdf.to_crs("EPSG:3006")

    # Normalise column names: lowercase + replace : and - with _
    # GeoPackage field names are case-insensitive, so FIXME vs fixme collides.
    seen = {}
    rename = {}
    for col in gdf.columns:
        if col == "geometry":
            continue
        norm = col.lower().replace(":", "_").replace("-", "_").replace(" ", "_")
        if norm in seen:
            rename[col] = f"{norm}_{seen[norm]}"
            seen[norm] += 1
        else:
            rename[col] = norm
            seen[norm] = 1
    gdf = gdf.rename(columns=rename)

    print("\nHighway types:")
    if "highway" in gdf.columns:
        print(gdf["highway"].value_counts().to_string())
    print("\nWaterway types:")
    if "waterway" in gdf.columns:
        print(gdf["waterway"].value_counts().to_string())

    gdf.to_file(args.out, driver="GPKG")
    print(f"\nSaved {len(gdf)} features → {args.out}")


if __name__ == "__main__":
    main()
