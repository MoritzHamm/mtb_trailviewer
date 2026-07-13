# foundation/ — Shared LiDAR/OSM Data Pipeline

See the repo-root `CLAUDE.md` first for project-wide context (data sources, environment,
the three-pronged repo structure, git worktrees). This file covers what's specific to
working in `foundation/`.

## What this directory does

Turns raw LAZ point clouds + OSM PBF + SLU wetness GeoTIFF into the tile products
`mtb-editor/` (and eventually `game-editor/`) consume: a DTM/CHM raster pipeline, OSM
vector layer extraction, and packing everything into PMTiles/terrain-RGB tile pyramids.

`osm/` (PBF storage) and `dtm/` are gitignored — regenerate or re-download, don't expect
them from git.

## Scripts

### Rasterization (LAZ → GeoTIFF)
- **`rasterize.py`** — single-tile: reads one LAZ file, filters to ground points
  (class 2), rasterizes to a 1m DTM, fills gaps. Also produces DSM (highest return per
  cell), CHM (DSM − DTM, clamped, structures masked), CDM (canopy density = non-ground
  return ratio), and a hillshade PNG.
- **`batch_rasterize.py`** — multi-tile: LAZ files → per-tile DTM + CHM GeoTIFFs +
  merged VRTs. Skips existing outputs, so re-running resumes rather than restarts. If a
  DTM exists but CHM is missing, re-reads the LAZ to rebuild DSM.
- **`prepare_pipeline.sh`** — wraps `batch_rasterize.py` for the full Dalarna LAZ
  archive; output goes to `~/lidar-output/dtm` (local, fast — this is a
  millions-of-small-files-adjacent job).
- **`compute_lrm.py`** — Local Relief Model (LRM = DTM − Gaussian-smoothed DTM),
  processed in overlapping blocks so it scales to full-Dalarna VRTs that don't fit in
  RAM (overlap must exceed 3×sigma to keep edge artefacts out of the inner block;
  default overlap=256 covers sigma≤85). **Currently unused** — removed from the overlay
  pipeline pending a dedicated test setup (see `generate_overlay_tiles.py` below).

### OSM extraction
- **`extract_osm.py`** — PBF → line/point GeoJSON layers (roads, tracks, paths,
  waterways, railways, powerlines, natural_lines, peaks, places). Two-pass: pass 1
  (`RouteRelationCollector`) builds `way_id → (route_type, name, relation_id)` from
  `type=route` relations (mtb/bicycle/ski/hiking/foot/horse, priority in that order)
  since PBFs list relations after the ways they reference; pass 2 attaches
  `route_type`/`route_name`/`route_relation_id` to the matching ways. Writes
  FeatureCollections by hand (not `geopandas.to_file()` — see Gotchas) and back-fills
  missing peak elevations from the DTM.
- **`extract_osm_polygons.py`** — PBF → polygon GeoJSON layers (water, landuse,
  buildings) via `ogr2ogr`/GDAL's OSM driver, which correctly assembles multipolygon
  relations (osmium alone doesn't handle that well).
- **`download_osm.py`** — older/simpler OSM extractor (highway + waterway only, writes
  GeoPackage). Superseded by `extract_osm.py` for the main pipeline; kept for reference.
- **`export_osm_geojson.py`** — GeoPackage → WGS84 GeoJSON. Old one-off utility, not
  called by `build_pipeline.sh` — check before relying on it, may be dead code.
- **`refresh_osm.sh`** — re-downloads the Geofabrik Sweden PBF and rebuilds only
  `dalarna.pmtiles`, leaving DTM/CHM/overlay/terrain untouched. Geofabrik regenerates
  extracts roughly every 24h from OSM planet diffs, so that snapshot cadence — not how
  often you run this — is the bottleneck for edits landing here. Not scheduled; run
  manually.

### Tile generation & packing
- **`generate_elevation_tiles.py`** — DTM GeoTIFF → Mapbox terrain-RGB tiles.
  Encoding: `height_m = -10000 + (R*65536 + G*256 + B) * 0.1`. Z12–Z15 by default.
- **`generate_overlay_tiles.py`** — packs 8-bit analysis layers into an RGBA tile
  pyramid: R=reserved (LRM removed for now), G=SVF (placeholder 0, not yet computed),
  B=CHM (0=bare, 255=35m canopy), A=Wetness (0=dry, 255=wet). Missing source channels
  fill with their neutral value. **Retired for now** per the reorg — see "Overlay
  status" below.
- **`pack_tiles.py`** — z/x/y.png tile directory → single PMTiles archive, via the
  `go-pmtiles` CLI. Tile reads are parallelised: reading millions of small files one at
  a time on a slow network mount (`/mnt/*`) turns into a many-hour crawl, so
  `tile_dir` should live on fast local storage.
- **`log_utils.py`** — shared logging: `log(msg)` (timestamped permanent line) and
  `Progress(...)` (in-place `\r`-refreshed line with ETA, so long tile loops don't
  flood logs with one line per checkpoint).

### `build_pipeline.sh` — the orchestrator
Runs OSM extraction → vector PMTiles → (optionally) overlay tiles → (optionally)
terrain-RGB tiles → copies results into `mtb-editor/tiles/`.

```
bash build_pipeline.sh [--skip-osm] [--skip-overlay] [--skip-terrain]
bash build_pipeline.sh --skip-osm                      # overlay + terrain only
bash build_pipeline.sh --skip-terrain --skip-overlay   # OSM/vectors only
bash build_pipeline.sh --work-fast=/path --work-slow=/path --mtb-editor-dir=/path
```
Other flags: `--max-zoom=`, `--bbox=`, `--dtm=`/`--chm=`/`--wetness=` (source
overrides, e.g. for a single-tile test run instead of the full merged VRT).

Two work-dir tiers, matched to WSL2's storage characteristics:
- **WORK_FAST** (`~/lidar-output`, default) — raw z/x/y.png tile pyramids. Millions of
  small files; needs fast local disk or generating/packing becomes a multi-hour crawl.
- **WORK_SLOW** (`/mnt/g/lidar-output`, default) — OSM layers, finished `.pmtiles`. Few,
  larger files — a slower mount is fine, and it keeps this off the small local disk.

`MTB_EDITOR_DIR` defaults to `$LIDAR_DIR/../mtb-editor` (a sibling since the reorg —
it used to be a child directory `viewer/`).

### Overlay status
Overlay tiles (vegetation height + wetness) are **on hold** pending a rework:
restricting generation to terrain's real-coverage footprint, and moving wetness off the
alpha channel (packing data into alpha is fragile — see the canvas premultiplied-alpha
bug in `mtb-editor/CLAUDE.md`, which was a direct consequence of that choice). The old
256GB of raw overlay source tiles was deleted from local disk to reclaim space; the old
`overlay.pmtiles` build still exists at `/mnt/g/lidar-output/overlay.pmtiles` as a
fallback, not currently deployed to R2.

## Known Issues / Gotchas (pipeline-specific)

- `np.array(las.x[mask])` — must convert laspy arrays to plain numpy before boolean
  mask indexing, or indexing silently misbehaves
- `np.maximum.at` with NaN initial values doesn't work — use `-np.inf` sentinel for DSM
- Gap filling: 5× iterative 3×3 mean kernel, then `distance_transform_edt` for larger
  gaps; CHM NaNs from DSM−DTM subtraction need `fill_gaps` run again after subtraction
- Artificial structures (cell towers etc.) show up as CHM outliers — clip display to
  ~35m max
- No SRS in LAZ file — set `crs="EPSG:3006"` explicitly when writing GeoTIFF
- `extract_osm.py`'s `_write()` deliberately does **not** use
  `geopandas.GeoDataFrame.to_file()` — a GeoDataFrame unions every row's keys into one
  column set, so every feature carries every tag key any feature in the layer has
  (was ~250 properties/feature, ~5 ever non-null). Writing FeatureCollections by hand
  and dropping `None` values cut `roads.geojson` 868MB→58MB and sped up tippecanoe
  dramatically. Don't reintroduce `to_file()` for these layers.
- Route relations (`type=route`): PBFs list relations *after* the ways they reference,
  so a single streaming pass can't attach a route's name to its ways as it goes — this
  is why `extract_osm.py` does two passes (see above).
- Overpass API returns 406 from WSL — use the local PBF instead
- osmium pip package is `osmium`, not `pyosmium`
- osmnx bbox area warning — bypass with direct osmium PBF reading (avoided by not using
  osmnx for extraction at all)

## What Comes Next (pipeline stabilisation)

Documentation vs. reality check: contour-line generation (Gaussian pre-smooth → trace →
Douglas-Peucker → Chaikin smoothing, described in earlier project notes) does **not**
currently exist as a script anywhere in this repo — it needs to be re-implemented, not
just refactored. Treat any old references to a working `contours.py` as aspirational.

1. **Multi-tile merging** — `rasterio.merge` to mosaic adjacent DTM tiles with overlap
   buffer (~20px); run contour generation (once it exists) on the merged raster to
   avoid seam artifacts.
2. **Contour generation** — needs building from scratch: trace contours from the DTM,
   simplify (Douglas-Peucker), smooth (Chaikin), output in SWEREF99TM/WGS84 (not pixel
   space), tiered by 5m/25m/100m hierarchy for styling.
3. **Cliff detection** — derive from DTM slope raster (slope > threshold → cliff),
   output as vector polygons/lines.
4. **SVF (Sky View Factor)** — currently a placeholder-0 channel in
   `generate_overlay_tiles.py`; needs an actual computation.
5. **Overlay rework** — see "Overlay status" above.
