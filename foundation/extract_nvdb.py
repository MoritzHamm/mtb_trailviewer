#!/usr/bin/env python3
"""
Extract Trafikverket NVDB road data (Lastkajen county GeoPackage) → one WGS84 GeoJSON
of road stretches carrying the cycle-relevant attributes, for tippecanoe.

NVDB stores every attribute as its own layer, linearly referenced onto the road
network: ELEMENT_ID (= the link sequence) + START/END_MEASURE as 0–1 fractions of
it. Net_VAG_Link holds the geometry, as pieces of a link sequence with their own
measure range. So: collect every attribute's start/end measure per link sequence,
cut the link geometries at those breakpoints, look each piece's attributes up at its
midpoint, then re-join consecutive pieces whose attributes are all equal.

Properties per stretch (absent = NVDB has no value there):
    nvdb_id   link sequence id (ELEMENT_ID), e.g. "1000:86231"
    net       bil | cykel | gang          (Vagtrafiknat: car / cycle / foot network)
    surface   belagd | grus               (Slitlager: paved / gravel)
    klass     0–9, 0 = most important     (FunkVagklass)
    owner     statlig | kommunal | enskild (Vaghallare)
    speed     km/h; 7 for "gångfart"      (Hastighetsgrans, either direction)
    width     m                           (Vagbredd)
    adt       vehicles/day, adt_heavy     (Trafik — state roads only)
    name      street/road name            (Gatunamn)
    ref       road number, "E45" / "70"   (Vagnummer)
    category  Europaväg | Riksväg | Primär länsväg | Övrig länsväg (Vagkategori)
    subsid    1 = private road with state maintenance subsidy (Driftbidrag statligt) —
              such roads must be kept open to the public
    gcm       cycle/foot way type, e.g. "Gång- och cykelbana" (GCM_vagtyp)
    cycle_route  tourist cycle route name  (Turismcykelled)
    bridge    Bro | Tunnel | …            (Bro_och_tunnel Konstruktion)
    access    A–D, heavy-vehicle accessibility (Tillganglighet, the forestry road
              classes): A all year, B all year except during spring thaw, C dry
              season only (summer/bare ground), D winter (frozen ground) only
    bk        bearing class: BK4 (74 t gross) | BK4s (BK4 with special terms) |
              BK1 (64 t) | BK2 (51.4 t) | BK3 (37.5 t) — state/municipal roads
    max_weight  permanent gross-weight limit in tonnes (BegrBruttovikt), rare

Not included: temporary thaw restrictions (TFR Tjälrestriktion) — the package only
holds the ones in force on its export date, so they're a snapshot, not a property.

Owner names (Vaghallarnamn) are deliberately left out — for private roads they can
be private persons.

Several GeoPackages (e.g. one per county) can be given; they're processed one after
another into the same output; links a neighbouring county already contributed are skipped.

Usage:
    python extract_nvdb.py ~/lidar-output/trafikverket/dalarnas_lan/dalarnas_lan.gpkg \\
        --out ~/lidar-output/nvdb/nvdb.geojson
    python extract_nvdb.py dalarnas_lan.gpkg --out test.geojson --bbox 525000 6715000 545000 6735000
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import pyogrio
import shapely
from shapely.ops import substring

from log_utils import log

# (layer, {source column: output property}) — the first row per layer wins where
# directional duplicates overlap (e.g. separate Med/Mot speed limits).
ATTR_LAYERS = [
    ('NVDB_DK_O_88_Vagtrafiknat',      {'Nattyp': 'net'}),
    ('NVDB_DK_O_30_Slitlager',         {'Slitlagertyp': 'surface'}),
    ('NVDB_DK_O_38_FunkVagklass',      {'Klass': 'klass'}),
    ('NVDB_DK_O_2_Vaghallare',         {'Vaghallartyp': 'owner'}),
    ('NVDB_DK_O_48_Hastighetsgrans',   {'Hogsta_tillatna_hastighet': 'speed'}),
    ('NVDB_DK_O_31_Vagbredd',          {'Bredd': 'width'}),
    ('TRAFIK_DK_O_105_Trafik',         {'Adt_samtliga_fordon': 'adt', 'Adt_tunga_fordon': 'adt_heavy'}),
    ('NVDB_DK_O_20_Gatunamn',          {'Namn': 'name'}),
    ('NVDB_DK_O_111_Vagnummer',        {'Europavag': '_eur', 'Huvudnummer': '_nr'}),
    ('AGGREGAT_O_68_Vagkategori',      {'Kategori': 'category'}),
    ('EVB_O_10368_Driftbidrag_statligt', {'Vagnr': 'subsid'}),
    ('NVDB_DK_O_99_GCM_vagtyp',        {'Gcm_typ': 'gcm'}),
    ('NVDB_DK_O_108_Turismcykelled',   {'Namn': 'cycle_route'}),
    ('NVDB_DK_O_25_Bro_och_tunnel',    {'Konstruktion': 'bridge'}),
    ('NVDB_DK_O_34_Tillganglighet',    {'Tillganglighetsklass': 'access'}),
    ('NVDB_DK_O_10_Barighet',          {'Barighetsklass': 'bk'}),
    ('NVDB_DK_O_6_BegrBruttovikt',     {'Hogsta_tillatna_bruttovikt': 'max_weight'}),
]

EPS = 1e-9


def read_table(gpkg, layer, cols, bbox):
    df = pyogrio.read_dataframe(gpkg, layer=layer, columns=['ELEMENT_ID', 'START_MEASURE', 'END_MEASURE', *cols],
                                bbox=bbox, read_geometry=False)
    return pd.DataFrame(df.drop(columns='geometry', errors='ignore'))


def process(gpkg: str, bbox, seen_links: set) -> gpd.GeoDataFrame:
    log(f"Reading {gpkg}")
    # Net_VAG_Link declares geometry type "3D Unknown", which pyogrio refuses to
    # read directly — CastToXY in SQLite SQL gives it a concrete 2D type.
    links = pyogrio.read_dataframe(
        gpkg, bbox=bbox, sql_dialect='SQLITE',
        sql='SELECT LINKSEQUENCE_OID, START_MEASURE, END_MEASURE, CastToXY(geom) AS geom FROM Net_VAG_Link')
    links = links[links.geom_type == 'LineString'].rename(
        columns={'LINKSEQUENCE_OID': 'eid', 'START_MEASURE': 'ls', 'END_MEASURE': 'le'})
    links = links[links['le'] - links['ls'] > EPS].reset_index(drop=True)
    # A link sequence crossing a county border can be in both neighbours' packages —
    # sometimes whole, sometimes clipped to each county's own part. Drop exactly the
    # links an earlier package already contributed, keep the rest of the sequence.
    keys = links['eid'] + '|' + links['ls'].round(9).astype(str) + '|' + links['le'].round(9).astype(str)
    dup = keys.isin(seen_links).to_numpy()
    if dup.any():
        log(f"  skipping {dup.sum():,} links already read from an earlier package")
    seen_links.update(keys[~dup])
    links = links[~dup].reset_index(drop=True)
    log(f"  {len(links):,} links, {links.length.sum() / 1000:,.0f} km")

    tables = {}
    bps = [links[['eid', 'ls']].rename(columns={'ls': 'm'})]
    for layer, cols in ATTR_LAYERS:
        try:
            t = read_table(gpkg, layer, list(cols), bbox)
        except Exception as e:  # layer missing in this package
            log(f"  {layer}: skipped ({e.__class__.__name__})")
            continue
        t = t.rename(columns={'ELEMENT_ID': 'eid', 'START_MEASURE': 's', 'END_MEASURE': 'e', **cols})
        t = t[t.e - t.s > EPS]
        t['eid'] = t['eid'].astype(object)   # an empty table reads as a different dtype → merge_asof refuses
        tables[layer] = t
        bps += [t[['eid', 's']].rename(columns={'s': 'm'}), t[['eid', 'e']].rename(columns={'e': 'm'})]
        log(f"  {layer:34s} {len(t):8,} rows")
    bp = pd.concat(bps, ignore_index=True).drop_duplicates().sort_values(['eid', 'm'])
    bp_by_eid = {k: g.to_numpy() for k, g in bp.groupby('eid', sort=False)['m']}

    # Cut every link at the attribute breakpoints inside its measure range
    rows = []
    for eid, ls, le, geom in zip(links.eid.values, links['ls'].values, links['le'].values, links.geometry.values):
        m = bp_by_eid.get(eid)
        inner = m[(m > ls + EPS) & (m < le - EPS)] if m is not None else np.empty(0)
        cuts = np.concatenate([[ls], inner, [le]])
        span = le - ls
        for a, b in zip(cuts[:-1], cuts[1:]):
            g = geom if len(cuts) == 2 else substring(geom, (a - ls) / span, (b - ls) / span, normalized=True)
            if g.geom_type == 'LineString' and g.length > 0:
                rows.append((eid, a, b, (a + b) / 2, g))
    pieces = pd.DataFrame(rows, columns=['eid', 'a', 'b', 'mid', 'geometry'])
    pieces['eid'] = pieces['eid'].astype(object)
    log(f"  {len(pieces):,} pieces after cutting at attribute breakpoints")

    # Attribute lookup at each piece's midpoint
    pieces = pieces.sort_values('mid').reset_index(drop=True)
    for layer, t in tables.items():
        vals = [c for c in t.columns if c not in ('eid', 's', 'e')]
        t = t.sort_values('s').drop_duplicates(['eid', 's'])
        j = pd.merge_asof(pieces[['eid', 'mid']], t, left_on='mid', right_on='s', by='eid', direction='backward')
        hit = (j.e > j['mid']).to_numpy()
        for c in vals:
            pieces[c] = j[c].where(hit).to_numpy()

    # Derived / tidied properties
    if '_nr' in pieces:
        nr = pieces.pop('_nr'); eur = pieces.pop('_eur')
        pieces['ref'] = np.where(nr.notna(), np.where(eur == 'Ja', 'E', '') + nr.astype('Int64').astype(str), None)
    if 'net' in pieces:
        pieces['net'] = pieces.net.map({'bilnät': 'bil', 'cykelnät': 'cykel', 'gångnät': 'gang'})
    if 'speed' in pieces:
        pieces['speed'] = pd.to_numeric(pieces.speed.replace({'gångfart': '7'}), errors='coerce')
    if 'bk' in pieces:
        pieces['bk'] = pieces.bk.replace({'BK 4 - Särskilda villkor': 'BK4s'}).str.replace(' ', '', regex=False)
    if 'klass' in pieces:
        pieces['klass'] = pd.to_numeric(pieces.klass, errors='coerce')
    if 'subsid' in pieces:
        pieces['subsid'] = np.where(pieces.subsid.notna(), 1, None)
    for c in ('adt', 'adt_heavy', 'width', 'max_weight'):
        if c in pieces:
            pieces[c] = pd.to_numeric(pieces[c], errors='coerce')

    # Re-join consecutive pieces of one link sequence with identical attributes
    props = [c for c in pieces.columns if c not in ('eid', 'a', 'b', 'mid', 'geometry')]
    pieces = pieces.sort_values(['eid', 'a']).reset_index(drop=True)
    key = pd.util.hash_pandas_object(pieces[props], index=False)
    new_run = (pieces.eid != pieces.eid.shift()) | (key != key.shift()) | ((pieces.a - pieces.b.shift()).abs() > EPS)
    run = new_run.cumsum()
    out = []
    for _, g in pieces.groupby(run, sort=False):
        geoms = g.geometry.tolist()
        merged = geoms[0] if len(geoms) == 1 else shapely.line_merge(shapely.MultiLineString(geoms))
        rec = g.iloc[0][['eid', *props]].to_dict()
        for part in (merged.geoms if merged.geom_type == 'MultiLineString' else [merged]):
            out.append({**rec, 'geometry': part})
    gdf = gpd.GeoDataFrame(out, crs=3006).rename(columns={'eid': 'nvdb_id'})
    log(f"  {len(gdf):,} stretches, {gdf.length.sum() / 1000:,.0f} km")
    return gdf


def write_features(gdf: gpd.GeoDataFrame, f) -> int:
    """Append features as newline-delimited GeoJSON, null properties dropped per feature
    (keeps tiles small). One feature per line also lets tippecanoe --read-parallel split it."""
    gdf = gdf.to_crs(4326)
    props = [c for c in gdf.columns if c != 'geometry']
    coords = shapely.get_coordinates(gdf.geometry.values)
    counts = shapely.get_num_coordinates(gdf.geometry.values)
    offs = np.concatenate([[0], np.cumsum(counts)])
    for i, row in enumerate(gdf[props].itertuples(index=False)):
        p = {}
        for k, v in zip(props, row):
            if v is None or v is pd.NA or (isinstance(v, float) and np.isnan(v)):
                continue
            if isinstance(v, np.integer): v = int(v)
            elif isinstance(v, (np.floating, float)): v = int(v) if float(v).is_integer() else round(float(v), 1)
            p[k] = v
        c = np.round(coords[offs[i]:offs[i + 1]], 6).tolist()
        f.write(json.dumps({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': c},
                            'properties': p}, ensure_ascii=False, separators=(',', ':')) + '\n')
    return len(gdf)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('gpkg', nargs='+', help='NVDB GeoPackage(s) from Lastkajen, e.g. one per county')
    ap.add_argument('--out', required=True, help='Output newline-delimited GeoJSON (WGS84)')
    ap.add_argument('--bbox', nargs=4, type=float, default=None, metavar=('MINX', 'MINY', 'MAXX', 'MAXY'),
                    help='Restrict to a SWEREF99TM bbox (for testing)')
    args = ap.parse_args()

    bbox = tuple(args.bbox) if args.bbox else None
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    # Packages are written one at a time so a whole-Sweden run never holds more than
    # one county in memory (plus the set of link keys, for border de-duplication).
    seen_links, total = set(), 0
    with open(out, 'w') as f:
        for g in args.gpkg:
            total += write_features(process(g, bbox, seen_links), f)
    log(f"Done: {out}  ({out.stat().st_size / 1e6:.0f} MB, {total:,} features)")
    log(f"Next: tippecanoe -o nvdb.pmtiles -l nvdb -Z8 -z14 --no-feature-limit --no-tile-size-limit "
        f"--read-parallel {out}")


if __name__ == '__main__':
    main()
