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

### Rock / cliff layer
- **`compute_rock.py`** — DTM → `rock.tif` (uint8, nodata=0), block-processed like
  `compute_lrm.py`. Two bands in one channel: **1–127 rough ground** (local RMS over
  5×5 of DTM − Gaussian σ3 m, ramped 0.2 → 0.7 m) and **128–255 cliff face** (1 m slope,
  40° → 60°, wins over roughness). OSM roads/railways (10 m), tracks/buildings (5 m)
  and real-water shorelines (3 m, wetlands excluded) are buffered and masked to 0,
  since road cuts/embankments/building edges/gap-filled shores score as high as rock.
  Paths are deliberately not masked. 10×10 km around Falun: ~5 s compute + ~40 s OSM
  loading, 6.7 MB tif.
  `generate_overlay_tiles.py --rock` tiles it with **max** downsampling (a 1 m cliff
  still shows at Z12) and **lossless** WebP (lossy would smear values across the
  127/128 band boundary); tiles with no rock aren't written at all. Use a separate
  `--out` from the vegheight/wetness run (done-markers are per out dir). Test area:
  1,567 tiles Z12–16, 7.6 MB `rock.pmtiles` — roughly 2 GB extrapolated to Dalarna.
  `build_pipeline.sh` runs it as step 4b (`--skip-rock` to skip).
  **Full Dalarna (2026-10-18):** `rock.tif` 2.5 GB in `~/lidar-output/` (3,904 blocks,
  ~34 min on 12 workers, ~4 GB peak RSS; OSM mask load ~70 s for 470k features);
  tiling Z12–16 ~30 min → 461,419 tiles, 3.7 GB tile dir, **2.8 GB
  `/mnt/g/lidar-output/rock.pmtiles`**. z12 mosaic checked: no block seams, lakes empty,
  rougher terrain in the south/east than on the NW till plateaus.

  **Calibration (2026-10-18)** against spots given by the user, test area
  E 527500–537500 / N 6717500–6727500, `~/lidar-output/rock-test/`:
  | spot (WGS84) | what it is | result |
  |---|---|---|
  | 60.627188, 15.578835 | Lövberget, east-facing cliffs | both faces as cliff lines, rough ground around |
  | 60.633398, 15.571107 | one big boulder | distinct rough blob (peak roughness ~0.38 m) |
  | 60.631607, 15.628385 | Jungfruberget, cliffs + boulders | cliff + dense rough ground (also an OSM `natural=cliff`) |
  | 60.620048, 15.660815 | ski-jump runout, man-made cliff | strong cliff band (not masked, by design) |
  | 60.672612, 15.535891 | very steep, many boulders, few real cliffs | dense rough field with short cliff steps |
  | 60.627799, 15.566182 | steep west-facing slopes, **no** cliff | quiet — roughness p99 0.22 m vs ~0.35 m p95 on rocky ground |
  Steepness alone doesn't separate these; roughness does. Remaining false positives:
  unmapped forest roads/ditches/platforms, deep gullies.

  **Point-cloud boulder signals were tried and rejected for v1.** "Single-return points
  0.4–3 m above ground" mostly measured young forest/shrub (88% of hits under <8 m
  canopy — a boulder under canopy is the *last of several* returns, never a single
  return). "Pulse's last return stopped 0.4–3 m above ground" is physically better
  motivated but mostly lit up cars/sheds/fences and scattered single cells; it didn't
  stand out at any of the spots above. Exploration scripts were throwaway (not kept).

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

### Trafikverket NVDB roads
- **`extract_nvdb.py`** — Lastkajen NVDB GeoPackage(s) → one WGS84 GeoJSON of road
  stretches with cycle-relevant attributes (`net`, `surface`, `klass`, `owner`, `speed`,
  `width`, `adt`/`adt_heavy`, `name`, `ref`, `category`, `subsid`, `gcm`,
  `cycle_route`, `bridge`, `access` (forestry A–D: all year / except thaw / dry season /
  winter only), `bk` (bearing class), `max_weight` — see the docstring for value sets), then tippecanoe →
  `nvdb.pmtiles` (layer `nvdb`, z8–14, ~35MB for Dalarna). Source data CC0.
  Input: county package `Dalarnas_län_GeoPackage.zip` (extracted to
  `~/lidar-output/trafikverket/dalarnas_lan/dalarnas_lan.gpkg`); output
  `~/lidar-output/nvdb/nvdb.{geojson,pmtiles}`. ~1 min for Dalarna. Not yet in
  `build_pipeline.sh` — run by hand:
  `python extract_nvdb.py <gpkg> --out ~/lidar-output/nvdb/nvdb.geojson`, then the
  tippecanoe line it prints. Several county packages can be passed at once.
- How NVDB is laid out: each attribute is its own layer, linearly referenced onto link
  sequences (`ELEMENT_ID` + `START/END_MEASURE` as 0–1 fractions); `Net_VAG_Link` holds
  the geometry as pieces of a link sequence with their own measure range. The script
  cuts links at every attribute breakpoint, looks values up at each piece's midpoint
  (`merge_asof`), and re-joins equal neighbours. Gotcha: `Net_VAG_Link` declares
  geometry type "3D Unknown", which pyogrio refuses — read it through SQLite SQL with
  `CastToXY(geom)`.
- **Sweden-wide (Oct 2026):** 20 county packages (all but Västmanland, whose GeoPackage
  order came back empty; its FileGDB uses the native `TNE_*` schema the script can't
  read) extracted to `~/lidar-output/trafikverket/<county>_lan/<county>_lan.gpkg`
  (filenames normalised to ASCII — the zips' names come out as mojibake). Run with
  Dalarna first, ~26 min → `~/lidar-output/nvdb/nvdb_sweden.{geojson,pmtiles}` (1.4 GB /
  629 MB, 2.97M stretches, ~676,000 km); `mtb-editor/tiles/nvdb.pmtiles` points at it.
  Border roads: a link sequence crossing a county line can be in both packages, whole
  or clipped to each county's part — so de-duplication is per link (sequence id +
  measures), not per sequence (that dropped the second county's half).
- Owner names are deliberately left out (private roads can be owned by persons).
- Comparison with OSM (scratchpad analysis, Oct 2026): around Falun OSM roads are
  largely identical to NVDB (an import); in forest areas 26–35% of OSM road length is
  3–20 m off NVDB, and LiDAR canopy height says NVDB is the one on the road bed
  (95–99% of disputed samples canopy-free vs 64–70% for OSM). ~30% of OSM tracks around
  Falun have no NVDB partner; NVDB cycle network is ~98% already in OSM as paths. Merge
  approach (NVDB roads + OSM trails) undecided — the separate layer exists to compare first.

### Tile generation & packing
- **`generate_elevation_tiles.py`** — DTM GeoTIFF → Mapbox terrain-RGB tiles.
  Encoding: `height_m = -10000 + (R*65536 + G*256 + B) * 0.1`. Z12–Z15 by default.
- **`generate_overlay_tiles.py`** — writes two independent single-channel (grayscale)
  WebP tile pyramids, `vegheight/` (from CHM, 0=bare/255=35m canopy) and `wetness/`
  (0=dry/255=wet) — **not** packed into one RGBA tile, see "Overlay status" below for
  why. A tile is only written if CHM has a real pixel there, gating both layers so they
  always share the same real-coverage footprint even though wetness (SLU, all-Sweden)
  would otherwise have data everywhere. `--webp-quality` (default 55) controls both.
- **`pack_tiles.py`** — z/x/y.<ext> tile directory → single PMTiles archive, via the
  `go-pmtiles` CLI (`--format png`\|`webp` controls both the glob extension and the
  mbtiles `format` metadata; overlay's two layers each need their own `pack_tiles.py`
  call, pointed at `vegheight/`/`wetness/` respectively). Tile reads are parallelised:
  reading millions of small files one at a time on a slow network mount (`/mnt/*`) turns
  into a many-hour crawl, so `tile_dir` should live on fast local storage.
- **`log_utils.py`** — shared logging: `log(msg)` (timestamped permanent line) and
  `Progress(...)` (in-place `\r`-refreshed line with ETA, so long tile loops don't
  flood logs with one line per checkpoint).

### Contours
- **`contours.py`** — DTM → contour lines (default 5 m), as WGS84 GeoJSON + PMTiles
  (layer `contours`, properties `ele` and `level` = 100/25/5, the coarsest tier the
  line belongs to). Runs in overlapping chunks in parallel: NaN-aware Gaussian
  pre-smooth (`--sigma`, default 3 m — raw 1 m LiDAR contours are jagged) →
  `gdal_contour` (CLI; no GDAL Python bindings in the venv) → clip to chunk core →
  Douglas-Peucker (`--simplify` 0.5 m) → Chaikin (`--chaikin` 2, endpoints pinned so
  neighbouring chunks still meet) → drop closed rings < `--min-ring` 40 m → line-merge
  per elevation across seams. PMTiles zoom tiers (`--tiers`, default
  `100:10,25:12,5:14` = level:first zoom it's written into tiles); `--tiers
  100:10,25:10,5:10` keeps every line at every zoom (~20% bigger file, densest z10 tile
  ~190 KB) and leaves thinning to the map style — that's what the Falun preview files
  use, since the default thinning felt too aggressive when zooming out. Writes to `~/lidar-output/contours/` (local disk on purpose).
  ```
  python contours.py --bbox 525000 6712000 545000 6732000 --name contours_falun
  ```
  **Approved baseline look (2026-10-10):** the defaults — `--sigma 3 --simplify 0.5
  --chaikin 2 --min-ring 40` at 5 m interval ("looks great" on the Falun preview). Keep
  these as the defaults; smoother variants are experiments, pass them explicitly.
  Variants built for comparison (`mtb-editor/contours-preview.html`, local only):
  `--sigma 6 --min-ring 80 --chaikin 3` and `--sigma 12 --min-ring 150 --chaikin 3` —
  σ 12 is the pick for the stylised art piece.
  Falun 20×20 km: ~26 s on 12 workers, 4,839 lines / 2.5M vertices, 56 MB GeoJSON,
  9 MB PMTiles.

  **Full Dalarna (2026-10-10)** uses `--stream`: each chunk's lines are appended to
  `<name>.geojsonl` (newline-delimited GeoJSON) as soon as they're done instead of
  being held in memory and seam-merged, so lines stay split at the 5 km chunk edges
  (invisible when drawn; ~0.03% duplicated seam vertices). Output is written as
  `.partial` and renamed only when every chunk succeeded; a failed chunk is logged and
  the file isn't finalised. Region mode is unchanged (byte-identical output).
  ```
  python contours.py --stream --name contours_dalarna_s12 --sigma 12 --min-ring 150 \
      --chaikin 3 --tiers 100:10,25:10,5:10 --workers 16      # bbox defaults to DTM extent
  ```
  | | σ 12 (art) | σ 3 (approved, trail viewer) |
  |---|---|---|
  | run time (16 workers) | 21 min | 17 min |
  | lines / vertices | 219k / 224M | 498k / 220M |
  | `.geojsonl` | 4.9 GB | 4.8 GB |
  | `.pmtiles` | 595 MB | 946 MB |

  Elevations 55–1195 m. Peak memory ~7 GB. Outputs in `~/lidar-output/contours/`.
  Not wired into `build_pipeline.sh` / `mtb-editor/deploy.sh` yet.
  Verified: no dangling line ends on internal chunk seams, and 60 sampled tiles
  (z12/14/16) contain every source line. The lowest Falun contours (55–90 m) are the
  Falu Gruva open pit, not an artefact.

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
Overlay tiles (vegetation height + wetness) were on hold at 238GB in one `overlay.pmtiles`
— too big to deploy — for three compounding reasons, all fixed:

1. **Wrong footprint.** The old build wrote a tile whenever *any* channel had data
   anywhere in its 64-tile-wide read strip (`_strip_worker`'s `has_data` check operated
   per-strip, not per-tile). Since Wetness (SLU, all-Sweden) always has data, this wrote
   tiles across the *entire* Dalarna bounding rectangle, not just the ~46% that's real
   LiDAR coverage — `generate_elevation_tiles.py` avoids this because it reprojects one
   tile at a time, so its own per-tile "any real pixel" check is naturally exact. Fix:
   `_read_strip` now also returns the pre-fill validity mask, and a tile is written only
   if **CHM** (not wetness) has a real pixel somewhere in that specific tile — matching
   terrain's own footprint exactly, one-tile-at-a-time semantics included.
2. **Z17 wasn't worth it.** Z17 alone was 74.9% of terrain's real-coverage tile count
   (1,407,517 of 1,879,004) for detail (canopy height, wetness) that doesn't carry
   meaningful signal at that zoom. Default max zoom dropped **17 → 16**; the browser
   upscales Z16 for closer views.
3. **PNG was lossless on data that doesn't need to be — but naive lossy WebP was
   actively wrong, not just imprecise.** First attempt: pack CHM (R) + Wetness (G) into
   one RGBA tile, lossy WebP q55. Measured on real Lövberget data: mean CHM error
   13.7/255 (~1.9m), 44% of pixels off by more than 10/255, barely improving even at
   q90 (mean error 10.9/255). Root cause: WebP lossy always transforms RGB→YUV with
   4:2:0 chroma subsampling *regardless of quality* — packing two unrelated data
   channels into R/G bled real signal between them; this is inherent to the format, not
   a tunable setting. Fix: **two separate single-channel (grayscale "L") WebP
   tilesets**, `vegheight.pmtiles` + `wetness.pmtiles`, one PNG-equivalent request each
   (the viewer only ever shows one overlay at a time, so this costs nothing extra at
   request time). Grayscale has no chroma plane to bleed into — measured mean error
   dropped to ~3.5–4.6/255 (~0.6m CHM) at the same q55, an order of magnitude better,
   and still ~7x smaller than the old packed PNG (14.1 KB/tile combined vs. 98.2
   KB/tile). **Lesson: never pack unrelated data channels into one lossy-WebP/JPEG-style
   image — treat each data layer as its own grayscale image if lossy compression is
   used at all.**

Combined estimate (real tile counts from (1)+(2), measured combined bytes/tile from
(3)): 471,487 real-coverage tiles at Z12–16 × ~14.1 KB/tile ≈ **6.5–7GB total** for both
files (down from 238GB). `pack_tiles.py` gained a `--format` flag (`png`|`webp`)
controlling both the glob extension and the mbtiles `format` metadata field;
`generate_overlay_tiles.py` writes `vegheight/` and `wetness/` subdirectories, each
packed separately (`build_pipeline.sh` does both automatically).

**Side effect:** since each tileset is single-channel, data never touches alpha at all
(no R=CHM/G=wetness/B=reserved/A=255 packing needed either) — this also means the
overlay decode in `index.html` no longer needs UPNG's raw-byte parsing; a plain
`createImageBitmap`+canvas decode is safe (see the canvas premultiplied-alpha bug in
`mtb-editor/CLAUDE.md` for why that used to matter).

The old 256GB of raw overlay source tiles was deleted from local disk to reclaim space;
the old (pre-rework) `overlay.pmtiles` still exists at `/mnt/g/lidar-output/overlay.pmtiles`
as a fallback until the reworked build is verified and re-deployed. **Verified so far:
only the Lövberget sample tile (Z14-16, 115 tiles)** — code changes are in
`generate_overlay_tiles.py`/`pack_tiles.py`/`build_pipeline.sh`/`mtb-editor/deploy.sh`/
`mtb-editor/index.html`/`mtb-editor/style-config.js`, but the full-Dalarna run hasn't
happened yet (see "What Comes Next" below).

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
- **tippecanoe 2.49: don't use the per-feature `"tippecanoe": {"minzoom": …}` key** for
  contours — it made tippecanoe silently drop most lines from tiles (12 lines in, 1 out,
  even with a no-op minzoom, key order irrelevant). `contours.py` gets the same zoom
  tiers from a `-j` layer filter on `$zoom` instead. Verify tile contents with
  `tippecanoe-decode` whenever adding tiering to other layers.
- Overpass API returns 406 from WSL — use the local PBF instead
- osmium pip package is `osmium`, not `pyosmium`
- osmnx bbox area warning — bypass with direct osmium PBF reading (avoided by not using
  osmnx for extraction at all)

## What Comes Next (pipeline stabilisation)

1. **Contours into the pipeline** — full-Dalarna contours are built (see "Contours"
   above). Still to do: wire `contours.py --stream` into `build_pipeline.sh` and the
   chosen `.pmtiles` into `mtb-editor/deploy.sh` + the viewer style.
2. **Cliff detection** — raster version done (`compute_rock.py`, see "Rock / cliff
   layer"), built for full Dalarna; still to do: deploy (`mtb-editor/deploy.sh` picks
   up `tiles/rock.pmtiles`), and optionally vector cliff lines from the 128–255 band.
   Man-made false positives (road embankments, tunnel portals) are accepted as-is —
   the user judged OSM not accurate enough to mask them further and they're easy to
   recognise by eye.
3. **SVF (Sky View Factor)** — currently a placeholder-0 channel (B) in
   `generate_overlay_tiles.py`; needs an actual computation.
4. **Overlay rework** — code done, see "Overlay status" above. Still needed: run the
   full-Dalarna build (`build_pipeline.sh --skip-osm --skip-terrain`, CHM+wetness only,
   several hours — produces `vegheight.pmtiles` + `wetness.pmtiles`), verify the
   reworked decode in a browser, then `mtb-editor/deploy.sh --with-overlay` to actually
   ship it — none of that has run yet, only the Lövberget sample tile has been verified.
