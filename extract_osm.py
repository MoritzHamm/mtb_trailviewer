#!/usr/bin/env python3
"""
Extract OSM nodes and ways from a PBF → multiple WGS84 GeoJSON files.

Polygon features (water bodies, landuse, buildings) are handled by
extract_osm_polygons.py which uses ogr2ogr.

Output directory will contain:
  roads.geojson         — motor roads (primary … service)
  tracks.geojson        — forest/farm tracks
  paths.geojson         — paths, footways, cycleways, bridleways
  waterways.geojson     — streams, rivers, canals, drains
  railways.geojson      — rail, tram, light_rail, subway …
  powerlines.geojson    — power=line
  natural_lines.geojson — cliffs, ridges, coastline (from LiDAR later: cliffs only)
  peaks.geojson         — natural=peak/saddle/volcano (points)
  places.geojson        — city/town/village/hamlet/locality … (points)

Usage:
    python extract_osm.py \\
        --bbox 342500 6630000 600000 6900000 \\
        --pbf  /mnt/g/Download/sweden-latest.osm.pbf \\
        --out  /mnt/g/lidar-output/osm_layers
"""

import argparse
from collections import defaultdict
from pathlib import Path

import osmium
import geopandas as gpd
from shapely.geometry import LineString, Point
from pyproj import Transformer

PBF_DEFAULT  = "/mnt/g/Download/sweden-latest.osm.pbf"
OUT_DEFAULT  = Path("/mnt/g/lidar-output/osm_layers")
BBOX_DEFAULT = (342500, 6630000, 600000, 6900000)   # Dalarna LiDAR extent (SWEREF99TM)

ROAD_TYPES = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "service", "unclassified", "living_street",
    "motorway_link", "trunk_link", "primary_link",
    "secondary_link", "tertiary_link",
}
TRACK_TYPES = {"track"}
PATH_TYPES  = {"path", "footway", "cycleway", "bridleway", "steps", "pedestrian"}
RAIL_TYPES  = {"rail", "tram", "light_rail", "subway", "narrow_gauge",
               "monorail", "funicular", "miniature"}
NATURAL_LINE_TYPES = {"cliff", "ridge", "coastline", "arete", "valley"}

PEAK_TYPES  = {"peak", "saddle", "volcano", "hill", "mountain_pass"}
PLACE_TYPES = {"city", "town", "village", "hamlet", "suburb", "locality",
               "island", "islet", "isolated_dwelling", "farm", "neighbourhood",
               "quarter", "borough"}


def _sanitize(d: dict) -> dict:
    """Lowercase keys, replace : - space with _. Deduplicate with suffix."""
    out: dict = {}
    seen: dict = defaultdict(int)
    for k, v in d.items():
        norm = k.lower().replace(":", "_").replace("-", "_").replace(" ", "_")
        n = seen[norm]
        seen[norm] += 1
        out[norm if n == 0 else f"{norm}_{n}"] = v
    return out


class OSMHandler(osmium.SimpleHandler):
    def __init__(self, minlat: float, maxlat: float, minlon: float, maxlon: float):
        super().__init__()
        self.minlat, self.maxlat = minlat, maxlat
        self.minlon, self.maxlon = minlon, maxlon

        self._nodes: dict[int, tuple[float, float]] = {}   # for way assembly

        self.roads          : list[dict] = []
        self.tracks         : list[dict] = []
        self.paths          : list[dict] = []
        self.waterways      : list[dict] = []
        self.railways       : list[dict] = []
        self.powerlines     : list[dict] = []
        self.natural_lines  : list[dict] = []
        self.peaks          : list[dict] = []
        self.places         : list[dict] = []

    def _in_bbox(self, lon: float, lat: float, margin: float = 0.02) -> bool:
        return (self.minlat - margin <= lat <= self.maxlat + margin and
                self.minlon - margin <= lon <= self.maxlon + margin)

    def node(self, n):
        loc = n.location
        if not loc.valid():
            return
        lon, lat = loc.lon, loc.lat

        if self._in_bbox(lon, lat):
            self._nodes[n.id] = (lon, lat)

        if not (self.minlat <= lat <= self.maxlat and self.minlon <= lon <= self.maxlon):
            return

        tags = dict(n.tags)
        nat   = tags.get("natural", "")
        place = tags.get("place", "")
        if nat not in PEAK_TYPES and place not in PLACE_TYPES:
            return

        row = _sanitize(tags)
        row["osm_id"]  = n.id
        row["geometry"] = Point(lon, lat)

        if nat in PEAK_TYPES:
            self.peaks.append(row)
        else:
            self.places.append(row)

    def way(self, w):
        tags = dict(w.tags)
        hw  = tags.get("highway",  "")
        ww  = tags.get("waterway", "")
        rw  = tags.get("railway",  "")
        pwr = tags.get("power",    "")
        nat = tags.get("natural",  "")

        if not any([hw, ww, rw, pwr == "line", nat in NATURAL_LINE_TYPES]):
            return

        try:
            coords = [self._nodes[nd.ref] for nd in w.nodes if nd.ref in self._nodes]
        except Exception:
            return
        if len(coords) < 2:
            return

        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        if (max(lons) < self.minlon or min(lons) > self.maxlon or
                max(lats) < self.minlat or min(lats) > self.maxlat):
            return

        row = _sanitize(tags)
        row["osm_id"]   = w.id
        row["geometry"] = LineString(coords)

        if hw in ROAD_TYPES:
            self.roads.append(row)
        elif hw in TRACK_TYPES:
            self.tracks.append(row)
        elif hw in PATH_TYPES:
            self.paths.append(row)
        elif ww:
            self.waterways.append(row)
        elif rw in RAIL_TYPES:
            self.railways.append(row)
        elif pwr == "line":
            self.powerlines.append(row)
        elif nat in NATURAL_LINE_TYPES:
            self.natural_lines.append(row)


def _write(features: list[dict], path: Path) -> None:
    if not features:
        print(f"  {path.name}: 0 features — skipped")
        return
    gdf = gpd.GeoDataFrame(features, crs="EPSG:4326")
    gdf.to_file(path, driver="GeoJSON")
    print(f"  {path.name}: {len(gdf)}")


def _fill_peak_elevations(peaks: list[dict], dtm_vrt: Path) -> None:
    """Sample DTM elevation for any peak missing an 'ele' tag."""
    import rasterio
    from pyproj import Transformer

    missing = [p for p in peaks if not p.get("ele")]
    if not missing:
        return
    if not dtm_vrt.exists():
        print(f"  (DTM not found at {dtm_vrt} — skipping elevation fill)")
        return

    t = Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)
    with rasterio.open(dtm_vrt) as src:
        for p in missing:
            lon = p["geometry"].x
            lat = p["geometry"].y
            x, y = t.transform(lon, lat)
            row, col = src.index(x, y)
            try:
                val = src.read(1)[row, col]
                if val != src.nodata and not (val != val):  # not nodata, not NaN
                    p["ele"] = str(round(float(val)))
            except Exception:
                pass

    filled = sum(1 for p in missing if p.get("ele"))
    print(f"  DTM elevation filled for {filled}/{len(missing)} peaks without OSM ele")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bbox", nargs=4, type=float,
                        metavar=("MINX", "MINY", "MAXX", "MAXY"),
                        default=BBOX_DEFAULT,
                        help="Bounding box in SWEREF99TM / EPSG:3006")
    parser.add_argument("--pbf", default=PBF_DEFAULT)
    parser.add_argument("--out", default=str(OUT_DEFAULT))
    parser.add_argument("--dtm", default="/home/mo/lidar/dtm/merged.vrt",
                        help="DTM VRT for filling missing peak elevations")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    minx, miny, maxx, maxy = args.bbox
    t = Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True)
    minlon, minlat = t.transform(minx, miny)
    maxlon, maxlat = t.transform(maxx, maxy)

    print(f"Bbox WGS84 : lon {minlon:.3f}–{maxlon:.3f}  lat {minlat:.3f}–{maxlat:.3f}")
    print(f"Streaming  : {args.pbf}")
    print()

    h = OSMHandler(minlat, maxlat, minlon, maxlon)
    h.apply_file(args.pbf, locations=True)

    print(f"Writing layers → {out}/")
    _write(h.roads,         out / "roads.geojson")
    _write(h.tracks,        out / "tracks.geojson")
    _write(h.paths,         out / "paths.geojson")
    _write(h.waterways,     out / "waterways.geojson")
    _write(h.railways,      out / "railways.geojson")
    _write(h.powerlines,    out / "powerlines.geojson")
    _write(h.natural_lines, out / "natural_lines.geojson")
    _fill_peak_elevations(h.peaks, Path(args.dtm))
    _write(h.peaks,         out / "peaks.geojson")
    _write(h.places,        out / "places.geojson")
    print("\nDone. Run extract_osm_polygons.py next for water/landuse/buildings.")


if __name__ == "__main__":
    main()
