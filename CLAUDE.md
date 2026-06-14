\# Terrain Map Card — Project Summary for Claude Code



\## Project Goal



Build a pipeline that processes LiDAR point cloud data (LAZ files) from Lantmäteriet's

national laser scanning program into a mobile and browser mapping application, targeting

mountain bikers in the Falun/Dalarna region of Sweden. The end product is an app with

rich terrain visualisation — hillshading, vegetation height, soil wetness, contour lines,

OSM features (trails, roads, waterways), and gradient-aware trail rendering.



\---



\## Environment



\- \*\*OS:\*\* Ubuntu 24.04 LTS on WSL2 (Windows machine named SOLVEIG)

\- \*\*Python:\*\* 3.12 in a venv at `\~/lidar-env`

\- \*\*Working directory:\*\* `/home/mo/lidar/`

\- \*\*Data directory:\*\* `/mnt/g/Download/` (Windows drive G, \~2TB of LAZ files)

\- \*\*Output directory:\*\* `/mnt/g/lidar-output/`

\- \*\*Git:\*\* version control started during this project



\### Installed Python packages

```

laspy\[lazrs]==2.7.0

rasterio==1.5.0

numpy==2.4.4

pyproj==3.7.2

scipy

matplotlib

geopandas==1.1.3

osmnx==2.1.0

osmium

```



\### Installed system packages (via UbuntuGIS PPA)

```

pdal 2.6.2

gdal 3.11.4

proj 9.4.1

liblaszip-dev

```



\---



\## Data Sources



\### LiDAR — Lantmäteriet National Laser Scanning

\- \*\*Format:\*\* LAZ (compressed LAS 1.2)

\- \*\*Location:\*\* `/mnt/g/Download/\*.laz`

\- \*\*Coverage:\*\* Dalarna region (\~2TB, \~4800+ tiles)

\- \*\*Tile naming:\*\* `{batch}\_{northing}\_{easting}\_{offset}.laz`

&#x20; - Example: `19D021\_672\_53\_0000.laz`

&#x20; - Northing block 672 = 6720000–6730000 in SWEREF99TM

&#x20; - Easting block 53 = 530000–540000 in SWEREF99TM

&#x20; - Offset 0000 = SW corner at exactly that block origin

&#x20; - Tile size: 2.5 × 2.5 km

\- \*\*Point density:\*\* \~2.5 pts/m² total, \~1.15 ground pts/m²

\- \*\*CRS:\*\* SWEREF99TM (EPSG:3006) — \*\*not embedded in file\*\*, must be set explicitly

\- \*\*Classifications used:\*\*

&#x20; - 1 = Unclassified (mostly vegetation)

&#x20; - 2 = Ground

&#x20; - 7 = Noise

&#x20; - 9 = Water

&#x20; - 17 = Bridge deck

&#x20; - 18 = High noise



\### Development tile

`19D021\_672\_53\_0000.laz` covers E=530000–532500, N=6720000–6722500

This is the Lövberget/Stångtjärn area near Falun — well-known terrain, ideal for

ground-truth verification. Elevation range: 120–327m (post-noise-filtering).



\### SLU Markfuktighetskarta (Soil Wetness)

\- \*\*Format:\*\* GeoTIFF, \~70GB, covers all of Sweden

\- \*\*CRS:\*\* SWEREF99TM (EPSG:3006)

\- \*\*Resolution:\*\* 2×2m

\- \*\*Band 1:\*\* Continuous wetness index, 0 (dry) – 100 (wet), ML-derived

\- \*\*Band 2:\*\* Classified — 1=dry-fresh, 2=fresh-moist, 3=moist-wet, 4=open water

\- Use windowed reading via rasterio `from\_bounds` to extract tile area only



\### SLU Streams

\- \*\*Format:\*\* Shapefiles, split into thousands of numbered files

\- \*\*Location:\*\* `/mnt/g/SLU/Streams/10ha/` (10 hectare upstream catchment threshold)

\- Each numbered `.shp` is a spatial chunk covering part of Sweden

\- Good for capturing small drainage channels relevant to trail wetness



\### OSM Data

\- \*\*Source:\*\* `sweden-latest.osm.pbf` downloaded locally

\- \*\*Reading:\*\* via `osmium` Python package (streaming, no full load needed)

\- \*\*Key tags of interest:\*\*

&#x20; - `highway` — all road/path types

&#x20; - `waterway` — streams, rivers

&#x20; - `mtb:scale` — difficulty (0, 1, 1+, 2, 3)

&#x20; - `mtb:scale:imba` — IMBA difficulty

&#x20; - `surface` — asphalt/unpaved/ground/compacted etc.

&#x20; - `name` — for labels



\---



\## Scripts Produced (all in `/home/mo/lidar/`)



\### `rasterize.py`

Reads a LAZ file, filters to ground points (class 2), rasterizes to a 1m DTM,

fills gaps, writes GeoTIFF + hillshaded PNG.



Also produces:

\- \*\*DSM\*\* — highest return per cell (top of canopy)

\- \*\*CHM\*\* — DSM minus DTM = canopy height model (clamped, structures masked)

\- \*\*CDM\*\* — canopy density = ratio of non-ground returns per cell



Key implementation notes:

\- Uses `np.array(las.x\[mask])` — must convert laspy arrays to plain numpy before indexing

\- DSM uses `-np.inf` sentinel (not `np.nan`) for `np.maximum.at` to work correctly

\- Gap filling: 5× iterative 3×3 mean kernel, then `distance\_transform\_edt` for larger gaps

\- CHM NaNs from DSM-DTM subtraction: run `fill\_gaps` on CHM itself after subtraction

\- Artificial structures (cell towers etc.) visible as CHM outliers — clip display to 35m max

\- No SRS in LAZ file — set `crs="EPSG:3006"` explicitly when writing GeoTIFF



\### `contours.py`

Generates contour lines from the DTM GeoTIFF.



Pipeline: Gaussian pre-smooth → trace contours → Douglas-Peucker → Chaikin smoothing



Key implementation notes:

\- \*\*Gaussian pre-smooth\*\* (`sigma=2.0`) on DTM before contouring — removes 1m grid noise

&#x20; without affecting the actual DTM GeoTIFF

\- \*\*Contour tracer\*\* (`trace\_contours`): walks the grid cell by cell following edge crossings,

&#x20; producing long polylines directly without a separate stitching step

&#x20; - Uses `h\_cross`/`v\_cross` edge crossing arrays

&#x20; - `quad\_crossings()` finds which edges of a quad are crossed

&#x20; - `next\_quad()` finds the neighbouring quad on the exit edge

&#x20; - Produces long chains — median \~100+ pts per polyline at good levels

\- \*\*Douglas-Peucker\*\* (`DP\_EPSILON=3.0`): reduces raw chain to direction-change skeleton

&#x20; - Uses explicit cross product: `line\[0]\*diff\[:,1] - line\[1]\*diff\[:,0]` (not np.cross,

&#x20;   deprecated for 2D in NumPy 2.0)

\- \*\*Chaikin smoothing\*\* (`CHAIKIN\_IT=5`): corner-cutting smoothing

&#x20; - \*\*Critical:\*\* interleave q and r correctly: `new\_pts\[0::2]=q; new\_pts\[1::2]=r`

&#x20; - Without correct interleaving, points are in wrong order → bundles/artifacts

&#x20; - Pin endpoints for open lines to prevent drift

\- \*\*Hierarchy:\*\* 5m minor (thin, low alpha), 25m medium, 100m major (thicker, higher alpha)

\- \*\*Colour:\*\* `#f07e0d` (warm orange, visible on hillshade)

\- \*\*Known limitation:\*\* currently works in pixel coordinates — needs refactor to SWEREF99TM

&#x20; for multi-tile use



\### `mfk.py` (soil wetness extraction)

Reads the SLU Markfuktighetskarta GeoTIFF using windowed reading, extracts the

area matching the DTM bounds, writes cropped GeoTIFFs and a PNG overlay.



\### `download\_osm.py` (OSM feature extraction)

Reads `sweden-latest.osm.pbf` using osmium streaming handler, extracts all

`highway` and `waterway` ways intersecting the tile bounding box, saves as GeoPackage.



Key implementation notes:

\- Overpass API queries from WSL return 406 errors — use local PBF instead

\- osmium package: `pip install osmium` (not `pyosmium`)

\- `handler.apply\_file(PBF\_FILE, locations=True)` streams whole file — takes a few minutes

&#x20; but memory-efficient

\- Filter ways by bbox after node lookup

\- Always reproject to SWEREF99TM after loading (`gdf.to\_crs("EPSG:3006")`)



\---



\## Architecture Decision: Target App



\*\*Platform:\*\* Flutter (mobile + web), using MapLibre GL (maplibre-gl-dart)



\*\*Tile strategy:\*\*

\- \*\*Raster tiles\*\* (hillshade, CHM, CDM, wetness): pre-generated, served from tile server

&#x20; - Format: \*\*Terrain RGB\*\* (elevation encoded into RGB channels) — NOT pre-baked hillshade

&#x20; - Hillshading computed at runtime in fragment shader → adjustable sun angle etc.

&#x20; - Zoom levels Z10–Z16

\- \*\*Vector tiles\*\* (paths, roads, contours, waterways, cliffs): PMTiles

&#x20; - Generated by tippecanoe from GeoPackage

&#x20; - Zoom levels Z8–Z16

&#x20; - Bundled locally for offline use (\~20–50MB for Dalarna trail network)



\*\*Runtime rendering:\*\*

\- Flutter `FragmentProgram` (GLSL fragment shader) for terrain rendering

&#x20; - Samples elevation tile, computes hillshade at runtime

&#x20; - Overlays CHM (canopy height), CDM (density), wetness — all as shader inputs

&#x20; - Adjustable sun angle, layer opacity, colour ramps

\- MapLibre vector layer for features

&#x20; - Runtime style expressions for mtb difficulty colouring, gradient colouring

&#x20; - Contour lines as vectors (not baked into raster)



\*\*Tile server:\*\* Martin (Rust-based), running on dedicated Linux machine (see below)



\*\*Offline strategy:\*\*

\- Vector PMTiles bundled with app (always available)

\- Raster tiles cached for recent viewports

\- Primary use online, offline as fallback



\---



\## Planned Hardware (dedicated Linux processing + server machine)



\- \*\*CPU:\*\* AMD Ryzen 9 9900X (12c/24t, 65W TDP, AM5)

\- \*\*Motherboard:\*\* ASUS ROG Strix B650E-F

\- \*\*RAM:\*\* 32GB DDR5-6000 CL30

\- \*\*OS drive:\*\* 1TB NVMe M.2

\- \*\*Data drive:\*\* Seagate Exos 12TB (CMR, for LAZ archive and processed outputs)

\- \*\*PSU:\*\* EVGA 750 G3 (existing)

\- \*\*Role:\*\* always-on, also runs Frigate NVR (currently on Intel NUC)

\- \*\*Ubuntu 24.04 Server\*\* (no GUI needed)



\---



\## What Works



\- \[x] Ubuntu 24.04 WSL2 environment fully set up

\- \[x] PDAL, GDAL, PROJ, laspy, rasterio, numpy, scipy, matplotlib all installed

\- \[x] LAZ tile identification by SWEREF99TM coordinates

\- \[x] DTM rasterization (ground class 2, 1m resolution, gap-filled)

\- \[x] DSM rasterization (max return per cell)

\- \[x] CHM = DSM - DTM (canopy height, gap-filled, outliers masked)

\- \[x] CDM (canopy density from return ratio)

\- \[x] Hillshade PNG output

\- \[x] SLU soil wetness extraction (windowed read from 70GB GeoTIFF)

\- \[x] OSM feature extraction from sweden-latest.osm.pbf

\- \[x] Contour line generation (trace + DP + Chaikin) with hierarchy styling



\---



\## What Comes Next



\### Immediate — pipeline stabilisation



1\. \*\*Refactor all scripts to use real-world coordinates (SWEREF99TM)\*\*

&#x20;  - Contour tracer currently works in pixel space — convert crossing points to

&#x20;    (easting, northing) using the rasterio transform

&#x20;  - All GeoPackage outputs must be in SWEREF99TM (or WGS84 for vector tiles)



2\. \*\*Multi-tile merging\*\*

&#x20;  - Use `rasterio.merge` to mosaic adjacent DTM tiles with overlap buffer (\~20px)

&#x20;  - Run contour generation on merged raster to avoid seam artifacts

&#x20;  - Batch processing script for all tiles in a bounding region



3\. \*\*OSM rendering script\*\*

&#x20;  - Render extracted OSM features on top of hillshade PNG

&#x20;  - Style hierarchy: roads → tracks → paths → waterways

&#x20;  - MTB difficulty colouring from `mtb:scale`

&#x20;  - Gradient colouring: split paths into segments, sample DTM elevation, compute rise/run



4\. \*\*Cliff detection\*\*

&#x20;  - Derive from DTM slope raster (slope > threshold → cliff)

&#x20;  - Output as vector polygons/lines into GeoPackage



\### Medium term — tile pipeline



5\. \*\*Terrain RGB tile generation\*\*

&#x20;  - Encode DTM elevation into RGB channels (Mapbox terrain RGB spec)

&#x20;  - `gdal2tiles` or custom Python tiler

&#x20;  - Z10–Z16 pyramid



6\. \*\*Ancillary raster tiles\*\*

&#x20;  - CHM tiles (canopy height encoded as single-channel)

&#x20;  - CDM tiles (density)

&#x20;  - Wetness tiles (from SLU MFK)



7\. \*\*Vector tile pipeline\*\*

&#x20;  - Export all features (OSM + generated) to GeoJSON/GeoPackage in WGS84

&#x20;  - Run tippecanoe to generate PMTiles archive

&#x20;  - Include: contours, paths, roads, waterways, cliffs, streams (SLU)



8\. \*\*Martin tile server setup\*\*

&#x20;  - Configure to serve raster tile pyramid

&#x20;  - Serve PMTiles for vector features



\### Long term — Flutter app



9\. \*\*Fragment shader\*\*

&#x20;  - GLSL shader that decodes terrain RGB and computes hillshade

&#x20;  - Samples CHM/CDM/wetness tiles as overlays

&#x20;  - Configurable sun angle, layer opacity, colour ramps



10\. \*\*MapLibre Flutter integration\*\*

&#x20;   - Raster tile source (terrain RGB → shader)

&#x20;   - Vector tile source (PMTiles)

&#x20;   - Runtime style: mtb difficulty, gradient colouring, surface type



11\. \*\*Navigation features\*\*

&#x20;   - Pan/zoom/rotate

&#x20;   - Heading-up mode

&#x20;   - Viewport tile caching for offline fallback

&#x20;   - Route recording (connects to existing MTB telemetry project)



\---



\## Known Issues / Gotchas



\- LAZ files have no embedded CRS — always set EPSG:3006 explicitly

\- `np.maximum.at` with NaN initial values doesn't work — use `-np.inf` sentinel

\- laspy arrays need `np.array()` conversion before boolean mask indexing

\- `np.cross` on 2D vectors deprecated in NumPy 2.0 — use explicit formula

\- Chaikin: MUST interleave q/r as `new\_pts\[0::2]=q; new\_pts\[1::2]=r`

\- Overpass API returns 406 from WSL — use local PBF file instead

\- osmium pip package is `osmium` not `pyosmium`

\- SLU CHM outliers (cell towers, etc.) — clip CHM display to realistic max (\~35m)

\- osmnx bbox area warning — bypass with direct osmium PBF reading



\---



\## Key References



\- Lantmäteriet LiDAR: https://www.lantmateriet.se/

\- SLU Markfuktighetskarta: http://www.slu.se/mfk

\- SWEREF99TM: EPSG:3006

\- MapLibre GL: https://maplibre.org/

\- PMTiles spec: https://github.com/protomaps/PMTiles

\- Tippecanoe: https://github.com/felt/tippecanoe

\- Martin tile server: https://martin.maplibre.org/

\- Terrain RGB spec: https://docs.mapbox.com/data/tilesets/guides/access-elevation-data/

