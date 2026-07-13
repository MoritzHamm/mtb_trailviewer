# Terrain Map Card — Project Summary for Claude Code

## Project Goal

Build a pipeline that processes LiDAR point cloud data (LAZ files) from Lantmäteriet's
national laser scanning program into terrain data products, and put that data to work
in three directions that share the same underlying geospatial layer:

- **foundation** — the shared LiDAR/OSM data pipeline (this doc's main subject historically)
- **mtb-editor** — a mountain-bike trail viewer/editor for the Falun/Dalarna region
- **game-editor** — a POI/quest authoring tool exporting Unity-importable levels (not started yet)

Rich terrain visualisation (hillshading, vegetation height, soil wetness, contour lines,
OSM features) is the common substrate all three consume.

---

## Repository Layout

```
/home/mo/lidar/
├── foundation/    — shared LiDAR/OSM pipeline. See foundation/CLAUDE.md
├── mtb-editor/    — MTB trail viewer/editor (web app). See mtb-editor/CLAUDE.md
├── game-editor/   — POI/quest editor, not started. See game-editor/CLAUDE.md
├── CLAUDE.md      — this file: shared context, environment, cross-cutting decisions
```

Each subdirectory has its own `CLAUDE.md` with prong-specific detail (scripts, gotchas,
architecture, current TODOs). This root file stays high-level and cross-cutting —
prefer editing the relevant subdirectory's file for anything specific to that prong.

### Working in parallel via git worktrees

Three sibling worktrees exist so the three prongs can be developed simultaneously
(including separate Claude Code sessions per prong) without file-save races in a
shared working directory:

```
/home/mo/lidar               main             (this checkout)
/home/mo/lidar-foundation    work/foundation
/home/mo/lidar-mtb-editor    work/mtb-editor
/home/mo/lidar-game-editor   work/game-editor
```

Each is a full checkout of the same repo on its own branch — `cd` between them, no
`git checkout` needed. Foundation changes should merge to `main` promptly since the
other two prongs depend on it; `mtb-editor`/`game-editor` branches can live longer and
should rebase/merge `main` periodically to pick up foundation updates. To add a fourth
worktree later: `git worktree add ../lidar-whatever -b work/whatever` from `/home/mo/lidar`.

---

## Environment

- **OS:** Ubuntu 24.04 LTS on WSL2 (Windows machine named SOLVEIG)
- **Python:** 3.12 in a venv at `~/lidar-env`
- **Working directory:** `/home/mo/lidar/`
- **Data directory:** `/mnt/g/Download/` (Windows drive G, ~2TB of LAZ files)
- **Output directory:** `/mnt/g/lidar-output/` (large/slow-mount-tolerant outputs) and
  `~/lidar-output/` (fast local disk, for millions-of-small-tile-files work — see
  `foundation/CLAUDE.md` for the WORK_FAST/WORK_SLOW split)
- **Git:** `git@github.com:MoritzHamm/mtb_trailviewer.git` (name predates the broader
  scope — not worth blocking on a rename, GitHub renames redirect automatically)

### Installed Python packages
```
laspy[lazrs]==2.7.0
rasterio==1.5.0
numpy==2.4.4
pyproj==3.7.2
scipy
matplotlib
geopandas==1.1.3
osmnx==2.1.0
osmium
```

### Installed system packages (via UbuntuGIS PPA)
```
pdal 2.6.2
gdal 3.11.4
proj 9.4.1
liblaszip-dev
```

Also installed: `tippecanoe` (vector tile packing), `go-pmtiles` CLI (`~/.local/bin/pmtiles`,
raster/vector PMTiles archive packing), `rclone` (Cloudflare R2 uploads).

---

## Data Sources

### LiDAR — Lantmäteriet National Laser Scanning
- **Format:** LAZ (compressed LAS 1.2)
- **Location:** `/mnt/g/Download/*.laz`
- **Coverage:** Dalarna region (~2TB, ~4800+ tiles)
- **Tile naming:** `{batch}_{northing}_{easting}_{offset}.laz`
  - Example: `19D021_672_53_0000.laz`
  - Northing block 672 = 6720000–6730000 in SWEREF99TM
  - Easting block 53 = 530000–540000 in SWEREF99TM
  - Offset 0000 = SW corner at exactly that block origin
  - Tile size: 2.5 × 2.5 km
- **Point density:** ~2.5 pts/m² total, ~1.15 ground pts/m²
- **CRS:** SWEREF99TM (EPSG:3006) — **not embedded in file**, must be set explicitly
- **Classifications used:** 1=Unclassified (mostly vegetation), 2=Ground, 7=Noise,
  9=Water, 17=Bridge deck, 18=High noise

### Development tile
`19D021_672_53_0000.laz` covers E=530000–532500, N=6720000–6722500 — the
Lövberget/Stångtjärn area near Falun, well-known terrain, ideal for ground-truth
verification. Elevation range: 120–327m (post-noise-filtering). Verified against
Lantmäteriet's published elevation for Bondberget (299–300m) during elevation-readout
debugging — see `mtb-editor/CLAUDE.md`.

### SLU Markfuktighetskarta (Soil Wetness)
- **Format:** GeoTIFF, ~70GB, covers all of Sweden
- **CRS:** SWEREF99TM (EPSG:3006), **Resolution:** 2×2m
- **Band 1:** Continuous wetness index, 0 (dry) – 100 (wet), ML-derived
- **Band 2:** Classified — 1=dry-fresh, 2=fresh-moist, 3=moist-wet, 4=open water
- Use windowed reading via rasterio `from_bounds` to extract tile area only

### SLU Streams
- **Format:** Shapefiles, split into thousands of numbered files
- **Location:** `/mnt/g/SLU/Streams/10ha/` (10 hectare upstream catchment threshold)
- Good for capturing small drainage channels relevant to trail wetness — not yet
  integrated into the pipeline

### OSM Data
- **Source:** `sweden-latest.osm.pbf` (Geofabrik snapshot, refreshed via
  `foundation/refresh_osm.sh`), stored at `foundation/osm/` (gitignored)
- **Reading:** via `osmium` Python package (streaming, no full load needed)
- **Key tags:** `highway`, `waterway`, `mtb:scale` (0, 1, 1+, 2, 3), `mtb:scale:imba`,
  `surface`, `name`, plus `type=route` relations for trail names — see
  `foundation/CLAUDE.md`

---

## Architecture Decision: End Consumers Never See This App

For both **mtb-editor** and **game-editor**, a central admin authors data here; end
consumers (ride participants, players) never touch this app — they get generated
export artifacts instead:

- **MTB editor:** ride participants get a GPX/FIT file and a route description (or a
  slimmed-down static map render). Supabase is the authoritative store for trail
  status/comments/route data; OSM integration lets the editor write trail edits back.
  A "local trail maintainer group" can collaborate — not relevant for the game side.
- **Game editor:** players get a Unity-importable "level" package, built from a
  capability manifest exported *from* Unity (what enemy/item/minigame types exist) so
  the editor knows what it's allowed to place. Supabase is the authoritative data
  store there too (a separate project from MTB's, for clean RLS/access separation);
  the Unity package is always a derived export, never hand-edited.

Both share the same underlying geospatial data (terrain, OSM trails/POIs) from
`foundation/`, which is why the repo stays a monorepo rather than splitting.

### Longer-term target app (original vision, still the eventual mobile target)

**Platform:** Flutter (mobile + web), MapLibre GL (maplibre-gl-dart), with terrain-RGB
raster tiles decoded and hillshaded at runtime in a GLSL fragment shader (adjustable
sun angle, layer opacity), vector tiles (PMTiles) for paths/roads/contours/waterways
with runtime style expressions (mtb difficulty, gradient colouring). Tile serving via
Martin (Rust) or, as currently implemented, Cloudflare R2 — see `mtb-editor/CLAUDE.md`
for what's actually running today (a browser/MapLibre GL JS viewer, not yet Flutter).

---

## Planned Hardware (dedicated Linux processing + server machine)

- **CPU:** AMD Ryzen 9 9900X (12c/24t, 65W TDP, AM5)
- **Motherboard:** ASUS ROG Strix B650E-F
- **RAM:** 32GB DDR5-6000 CL30
- **OS drive:** 1TB NVMe M.2
- **Data drive:** Seagate Exos 12TB (CMR, for LAZ archive and processed outputs)
- **PSU:** EVGA 750 G3 (existing)
- **Role:** always-on, also runs Frigate NVR (currently on Intel NUC)
- **Ubuntu 24.04 Server** (no GUI needed)

---

## Cross-cutting Known Issues / Gotchas

(Prong-specific gotchas live in each subdirectory's CLAUDE.md — these apply broadly.)

- LAZ files have no embedded CRS — always set EPSG:3006 explicitly
- `np.cross` on 2D vectors deprecated in NumPy 2.0 — use explicit cross-product formula
- Overpass API returns 406 from WSL — use the local PBF snapshot instead
- osmium pip package is `osmium`, not `pyosmium`
- WSL2 `/mnt/*` mounts are slow for millions-of-small-files workloads — keep those on
  local disk (`~/lidar-output`), only larger/fewer files on `/mnt/g`

---

## Key References

- Lantmäteriet LiDAR: https://www.lantmateriet.se/
- SLU Markfuktighetskarta: http://www.slu.se/mfk
- SWEREF99TM: EPSG:3006
- MapLibre GL: https://maplibre.org/
- PMTiles spec: https://github.com/protomaps/PMTiles
- Tippecanoe: https://github.com/felt/tippecanoe
- Martin tile server: https://martin.maplibre.org/
- Terrain RGB spec: https://docs.mapbox.com/data/tilesets/guides/access-elevation-data/
