# mtb-editor/ — MTB Trail Viewer/Editor

See the repo-root `CLAUDE.md` first for project-wide context. This directory currently
holds a browser-based terrain/OSM viewer (MapLibre GL JS) — the planned evolution
target is a collaborative MTB trail editor (Supabase-backed trail status/comments, OSM
write-back, route planning + GPX/FIT export), but that layer isn't built yet. What's
here today is the map viewing/rendering foundation that editor will sit on top of.

## Stack

- **MapLibre GL JS v4.4.0** + **PMTiles v4.5.0** (both CDN-loaded via unpkg, no build
  step) — `pmtiles://` protocol registered in `index.html`. Was pinned to 3.2.0 until it
  turned out to be missing several request-cancellation fixes landed in 4.x (properly
  aborting pending directory/tile requests instead of leaving a read half-consumed on
  cancellation) — surfaced as "incorrect header check" + aborted-operation console
  errors under heavy pan/zoom, across every PMTiles source in the app.
- **pako 2.1.0 + upng-js 2.1.0** (also CDN) — used to decode terrain-RGB/slope PNG tile
  bytes directly, bypassing `<canvas>` entirely (see Gotchas). Overlay tiles (vegheight/
  wetness) no longer need this — they moved off alpha entirely and decode via plain
  `createImageBitmap`+canvas.
- `style-config.js` — single source of truth for colors/gradients/opacities
  (`VIEWER_STYLE` object), kept separate from `index.html`'s map wiring so styling can
  be iterated on independently.
- `serve.py`/`serve.sh`/`serve.bat` — local dev server with HTTP Range support (needed
  for PMTiles byte-range fetching) and a remote-tile-proxy fallback (see below).
- `deploy.sh` — pushes static assets + tiles to Cloudflare R2.

## Tile files

`tiles/` is gitignored (large binaries). Expected contents when fully populated:
`dalarna.pmtiles` (OSM vector layers), `terrain.pmtiles` (terrain-RGB elevation, symlink
to `/mnt/g/lidar-output/terrain.pmtiles` on the desktop), `vegheight.pmtiles` +
`wetness.pmtiles` (each a separate single-channel/grayscale WebP tileset — reworked
from one packed `overlay.pmtiles`, see `foundation/CLAUDE.md`'s "Overlay status"; not
yet deployed to R2 — the old 238GB `overlay.pmtiles` is still what's live there until
the new build is run and pushed), `coverage.geojson` (mask showing what area has real
data). On a fresh checkout (e.g. a laptop), this directory may have little or nothing
in it — that's expected, see the tile-proxy section below.

## Local dev server + Cloudflare R2 tile proxy

Production serves the app and tiles from the same Cloudflare R2 custom domain
(`dalarna-mtb.hammer-tour.com`), behind Cloudflare Access (email OTP login) — same-origin
on purpose, since `pmtiles.js`'s fetches default to `credentials: 'same-origin'` and
would silently drop the Access session cookie on any cross-origin request.

For local dev (especially a laptop with no local pmtiles files), `serve.py`'s
`do_GET` checks whether the requested path exists locally; if not, it **proxies the
request to R2** (`_proxy_remote`), authenticating with a **Cloudflare Access Service
Token** (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers — a machine credential,
distinct from the email-login policy) and forwarding `Range`/`Content-Range`/`ETag` so
PMTiles range-fetching works transparently. The browser only ever talks to
`localhost:8080` — no CORS or cross-origin cookie handling needed at all, since the
proxying happens server-side in Python via `urllib.request`, not in the browser.

Credentials load from a gitignored local file, sourced by the entry-point script:
- Linux/WSL: `serve.sh` sources `.env` if present (`export CF_ACCESS_CLIENT_ID=...`)
- Windows: `serve.bat` calls `env.bat` if present (`set CF_ACCESS_CLIENT_ID=...`)

Templates: `.env.example` / `env.bat.example`. Without credentials set, missing paths
just 404 — nothing breaks on a machine with no token configured.

**Gotcha:** Cloudflare's bot protection blocks the default `Python-urllib/x.y`
User-Agent (error 1010) even with valid Access credentials — `_proxy_remote` sets an
explicit `User-Agent` header to work around this. Don't remove it.

Setting up a new Service Token (one-time, in the Cloudflare dashboard): Zero Trust →
Access → Service Auth → Service Tokens → Create Service Token, then add a policy with
**Action: Service Auth** for that token on the `dalarna-mtb.hammer-tour.com` Access
application (additive — the existing email-login policy stays for normal browsing).

`serve.py` has zero non-stdlib dependencies (just `os`/`shutil`/`urllib`/`http.server`/
`pathlib`) — it runs on plain Windows Python with no WSL/venv needed, which is why a
`.bat` entry point exists alongside the `.sh` one.

## `deploy.sh`

Uploads to Cloudflare R2 via `rclone` (remote `Dalarna-MTB`, bucket `dalarna-mtb`):
static assets (`index.html`, `style.css`, `style-config.js`, `favicon.ico`, `fonts/`)
every run, then `coverage.geojson` + `dalarna.pmtiles`, then optionally the large
`terrain.pmtiles`/`overlay.pmtiles` (real paths resolved via `readlink -f` since rclone
doesn't follow symlinks). `overlay.pmtiles` is skipped by default (`--with-overlay` to
force) — that data is retired pending the rework noted in `foundation/CLAUDE.md`.
R2's multipart cap is 10,000 parts, so large files use `--s3-chunk-size=256M` to stay
well under that on the terrain/overlay files (~250GB).

## Elevation / terrain-RGB rendering

- **3D terrain camera can freeze the map (upstream MapLibre bug).** With real terrain
  active (`map.setTerrain(...)`) at steep pitch, MapLibre's camera-to-terrain ray can
  fail to intersect anything and produce a NaN `LngLat`, which throws from inside
  MapLibre's own event dispatch (typically triggered by a `mouseout` while the camera
  grazes steep exaggerated terrain near `maxPitch`) and leaves the transform
  permanently poisoned — every further interaction re-throws, which reads as the map
  freezing. Mitigated, not eliminated: `maxPitch` lowered from MapLibre's default 85 to
  70 (steeper pitches are where this triggers most easily), plus a `window.on('error')`
  handler that detects the "Invalid LngLat" message and recovers by dropping out of 3D
  and resetting pitch to 0 (rebuilds the transform from scratch). If this still
  reproduces, the next lever is capping `vertSlider`'s max exaggeration (currently 4.0x)
  lower, or reducing `maxPitch` further — there's no way to fix the root cause from
  application code, only reduce how often the camera can end up in that state.
- Decoding: `height_m = -10000 + (R*65536 + G*256 + B) * 0.1` (Mapbox terrain-RGB spec).
- `sampleElevation()` (index.html) reads `terrain.pmtiles` bytes **directly** at a fixed
  zoom (17) via UPNG decode, bypassing MapLibre's `queryTerrainElevation()` API
  entirely. That API has two documented upstream bugs (maplibre-gl-js#6701): it samples
  the wrong-zoom DEM tile depending on view state, and `exaggerated: false` doesn't
  actually suppress the vertical-scale multiplier. Verified correct against Lantmäteriet's
  published elevation for Bondberget (299–300m) by independently decoding the same tile
  with Python/PIL (299.9m) — don't reintroduce the built-in API for elevation readout
  without re-verifying against ground truth.
- Slope color ramp (`style-config.js`, `VIEWER_STYLE.slope.stops`) is anchored in
  degrees but chosen for cycling relevance, not an even spread: flat stays blue through
  1°, ramps to orange by 5° (~8.7% grade), red by 25% grade (~14.0°), violet by 100%
  grade (45°, clamps there).

## Canvas premultiplied-alpha bug (history — why the overlay decode changed)

Overlay channels used to pack real data into the PNG **alpha** channel (wetness), not
real transparency. `<canvas>` surfaces store pixels premultiplied by alpha internally
regardless of compositing mode, so any pixel with alpha=0 permanently lost its RGB the
instant it was drawn — this silently zeroed out CHM/vegetation-height data wherever
wetness happened to be 0. Originally fixed by decoding PNG bytes directly via
`UPNG.decode()`/`UPNG.toRGBA8()` (pako-backed), bypassing
`createImageBitmap`/`OffscreenCanvas`/`getImageData` entirely.

**Superseded by the overlay rework** (see `foundation/CLAUDE.md`'s "Overlay status"):
CHM and wetness are no longer packed into one RGBA tile at all — each is its own
single-channel (grayscale) WebP tileset (`vegheight.pmtiles`/`wetness.pmtiles`), so
there's no alpha channel carrying data to begin with. This was forced by a second,
unrelated problem: WebP lossy compression transforms RGB→YUV with chroma subsampling,
which bled real signal between channels when CHM/wetness were packed into R/G together
(measured ~1.9m mean CHM error) — grayscale has no chroma plane to bleed into. With no
data in alpha (or any packed second channel), `makeGrayscaleProtocol` (`index.html`) now
decodes via plain `createImageBitmap` + `OffscreenCanvas.getImageData` — no custom
parser needed for this protocol. **This does not apply to terrain-RGB/slope**, which
still decodes via UPNG for exact-byte fidelity (elevation is encoded directly into RGB
bytes at 0.1m precision — any recompression or canvas color-management pass could shift
a byte and corrupt the decoded elevation); don't touch that path based on this section.

## Map layers dropdown (replaces the old "OSM lines"/"OSM areas" toggles)

`OSM_CATEGORIES` (`index.html`, near `map.on('style.load', ...)`) groups layers into
Tracks/Waterways/Other lines/Vegetation areas/Water areas/Others, each with its own
checkbox in `#osm-layers-panel` (persisted per-category via `osmCat_<key>` settings).
Grouping calls worth knowing: natural linear features (cliffs/ridges, `osm-natural-lines`)
went in with railways/powerlines as "Other lines" rather than getting their own category;
buildings/peaks/places are the "Others" catch-all. Revisit either if they end up wanting
independent toggles.

**Water vs. wetland — a real, useful data duplication, not a bug to "fix".**
`foundation/extract_osm_polygons.py`'s `WATER_NATURAL` and `NATURAL_LANDCOVER` sets both
include `"wetland"`, so every `natural=wetland` polygon lands in **both**
`water.geojson` and `landuse.geojson` (confirmed on real data: 84,323 of the 113,375
`water.geojson` features are `natural=wetland`, actually outnumbering real
`natural=water` at 29,010). `style-config.js`'s `osm.landuse.match` already had a
`wetland` color entry — it was just permanently invisible, masked underneath
`osm-water`'s old flat fill covering wetlands too. Fixed purely on the frontend (no
pipeline rebuild needed, the tag data was already there): `osm-water` now filters
wetlands out (`['!=', ['get','natural'],'wetland']`, real water only), and a new
`osm-wetland-pattern` layer (filtered to wetlands only) draws a tileable dashed-line
pattern (`addWetlandPatternImage()`, standard topo-map marsh symbol) with a
**transparent background**, over top of `osm-landuse`'s wetland tint — reusing color
data that already existed rather than inventing a new one. Also dropped
`waterway=flowline` (a directional flow indicator within wetlands/deltas, not a real
mapped watercourse) from `osm-waterway` via a filter — technically meaningful, but
reads as visual noise.

## OSM feature selection / highlighting

- Click-to-select reads `properties.osm_id`; route relations additionally carry
  `route_name`/`route_relation_id` (see `foundation/extract_osm.py`) used for the
  OSM link in the popup (`.../relation/{id}` vs `.../way/{id}`).
- Vector tiles clip geometry at tile boundaries, so a single OSM way can render as
  several separate features sharing one `osm_id`. The highlight logic queries the whole
  viewport (`map.queryRenderedFeatures`) and filters by matching `osm_id` across all
  relevant layers so every fragment of a clipped way gets highlighted, not just the one
  actually clicked.
- Selection highlight style: bright gold (`#fff700`), two stacked line layers — a wide
  blurred glow plus a narrower crisp core — styled after OSM's iD editor.

## Supabase backend (trail status/comments)

Schema lives at `supabase/migrations/0001_trails_and_history.sql` and **is live** —
project at `gergqrigdshvueljuvlm.supabase.co`, migration applied, RLS verified working
(anon key gets `[]`/403, authenticated-only access confirmed). Frontend so far: Supabase
client init + magic-link login UI in `index.html`/`style.css` (bottom-left panel).
Not built yet: the actual trail-editing UI (adding history entries, trail list view).

**What counts as a "trail" for lazy-population purposes** (matters once the
candidate-trail lookup/search feature gets built): a **way** needs an `mtb:name` or
`mtb:scale` tag; a **relation** just needs `route=mtb` — it does **not** need its own
`mtb:name`/`mtb:scale` tag (relations carry the route grouping/name via
`type=route`+`route=mtb`, per `foundation/extract_osm.py`'s `RouteRelationCollector`).
Don't require `mtb:name`/`mtb:scale` on relations when building that lookup.

**Design:**
- `trails` — one row per OSM way/relation *that's actually been worked on* in the
  editor (`osm_type`/`osm_id`), created lazily rather than bulk-importing every
  mtb-tagged OSM feature up front. OSM stays authoritative for location/name/
  `mtb:scale` — this table caches a lightweight display snapshot
  (`display_name`/`display_mtb_scale`/`display_lon`/`display_lat`, refreshed by the
  foundation pipeline) so the editor can show a trail list without the map/tiles
  loaded. Trails can also be **drafted in the editor before they exist in OSM**
  (`is_draft = true`, `osm_type`/`osm_id` null, geometry in `draft_geometry`) — once
  the trail's been created in OSM and shows up in a refreshed extract, reconcile by
  setting `osm_type`/`osm_id` and flipping `is_draft` false. That reconciliation step
  is manual for now; no automatic changeset-watching exists.
- `trail_history` — free-form `entry_type`/`value` (jsonb) pairs, matching the "type/
  value pairs" model directly rather than one column per entry type. Known types
  (`status`, `comment`, `image`) get their `value` shape checked by a CHECK
  constraint; unrecognised types pass through unchecked so new entry kinds don't need
  a migration first. Can attach to a `trail_id`, a `location` (point), or both (e.g.
  "windfall at this spot on trail X") — at least one is required, deliberately loose
  otherwise per the original design conversation ("keep it a bit free").
- Images: `trail-images` Storage bucket (private), referenced by
  `value->>'path'` on `entry_type='image'` rows.

**Three decisions made without a response during setup** (revisit if these don't
match intent):
1. **Auth is a separate Supabase magic-link (email OTP) login**, independent from the
   Cloudflare Access login already gating the site. Unifying them (having Supabase
   trust Cloudflare's Access JWT directly) isn't natively supported by Supabase
   Cloud — Access JWTs are RS256-signed against Cloudflare's own JWKS, and Supabase
   would need a custom edge function to validate that JWT and mint a Supabase
   session. Doable, but a separate, more fragile piece of work — not started.
2. **OSM display snapshot is cached** in `trails` (see above) rather than always
   resolving live from the vector tiles.
3. **RLS is fully open to any authenticated user** for both tables (read/write
   everything) — no per-row ownership restrictions. Fine for a small trusted
   maintainer group; tighten later if the group grows.

**Setup status:** project created, `0001_trails_and_history.sql` applied and RLS
verified live (anon key gets `[]`/403; authenticated-only access confirmed for both
tables and the `trail-images` bucket). Migrations `0002`–`0004` (see below for what
each does) must be run in order (SQL Editor) — `0002` in particular is required before
any insert will work at all, since the client code doesn't pass `created_by` explicitly
and relies on the default it adds.

**Frontend — click-to-add-entry flow (built):** clicking a feature that qualifies as a
trail (`getTrailIdentity()`, `index.html`) adds buttons to its popup when logged in:
"Add entry to trail", "Add entry at this point", and (only if the trail already has
history) "Show history" — hidden behind a "log in first" hint if not logged in. The two
"add" buttons open a modal (`#entry-form-wrap`) for a `status`/`comment`/`image` entry.
On submit: `ensureTrailRow()` upserts the lazy `trails` row (keyed by the clicked
feature's OSM identity, caching a display snapshot), then inserts into `trail_history`
— `location_id` is set only for "at this point" entries (see Locations below for how
that id is resolved).

**Point markers — "add another entry here" (built):** point-located entries render as
clickable markers (`history-points` layer); clicking one shows its value and, if
logged in, an "Add entry here" button to log a follow-up at the same spot (e.g. a
second update on the same windfall) — this path skips both `ensureTrailRow` and
`find_or_create_location` (see below) entirely via `pendingEntry.trailId`/`locationId`,
since there's no `trails`/`locations` row left to find-or-create when it's already
known, and reusing the marker's own id (rather than re-resolving from lng/lat) means
this can never accidentally attach to a *different* nearby location.

**Locations — giving a point its own history (built, `supabase/migrations/
0004_locations.sql`):** a `locations` table (id, `geog geography(Point,4326)`, label)
gives point-located entries a stable identity, replacing an earlier design where each
`trail_history` row carried its own disconnected point directly. Without that identity,
every "add entry here" created a brand-new, unrelated marker at (nearly) the same spot
instead of adding to that spot's history — there was no way to see "a tree fell here"
followed later by "cleared" as one continuous story. `trail_history.location_id`
references `locations(id)` (the old direct `location` column and its
`location_geojson` computed-column function from migration 0003 were dropped in favor
of this). `find_or_create_location(lng, lat, snap_meters=15)` — a Postgres function —
snaps a *newly* placed point ("add entry at this point", starting fresh from a trail's
popup) to an existing location within 15m if one exists, rather than always creating a
new one; only used when a locationId isn't already known (i.e. not the "add entry
here" path above, which always has one).

**Reading geography columns back out (important, easy to get wrong again):**
PostgREST returns PostGIS `geography` columns as raw **WKB hex text** by default, not
GeoJSON — `r.somecol.coordinates` on a plain `.select('somecol')` silently gets nothing
usable (this was a real bug caught before ever reaching a live insert: the original
point-marker code assumed GeoJSON and would have rendered zero markers). Fixed via a
PostgREST "computed column" — a SQL function taking the table's row type as its sole
argument, which PostgREST exposes as a selectable field. `locations` has one named
`geojson` (`.select('..., locations!inner(geojson)')`, returning
`ST_AsGeoJSON(geog)::jsonb`). Applies anywhere a `geography`/`geometry` column needs to
come back through supabase-js as usable coordinates — don't reintroduce a raw
`.select('some_geography_column')` expecting GeoJSON.

**Map display (built):** `trailStatusMap` (latest `status` per trail) recolors a
`trail-status` overlay layer; `trailHistorySet`/`trailIdByKey` (built from the same
query, dropping the `entry_type='status'` filter) drive the trail popup's "Show
history" button and skip a second round-trip to look up the trail's id. Since Supabase
only stores a trail's OSM reference, not its geometry, the overlay is rebuilt by
scanning currently-*rendered* vector tile features and matching their trail identity,
same technique as the pre-existing selection-highlight code (recomputed on `moveend`
and `sourcedata`). `'clear'` status (or no status at all) shows no overlay line, but a
trail with only comments/images (no status, or a 'clear' one) still gets the "Show
history" button via `trailHistorySet` — that's a separate check from the overlay color.
`fetchHistoryHtml(filterColumn, filterValue)` renders a trail's *or* location's full
history as a scrollable list (newest-first), used by both the trail popup's "Show
history" button (`'trail_id'`) and every point marker's popup, which always shows its
full history rather than just the latest entry (`'location_id'`) — images resolve to a
signed URL per view. Point markers (`history-points` layer) are deduplicated one per
`location_id` (not one per entry) and colored by that location's *latest* entry —
`status` entries reuse the trail overlay's clear/overgrown/blocked colors so a marker
visibly changes once someone logs it resolved, rather than staying a generic
"there's-history-here" color forever; `comment`/`image` entries with no status get
their own neutral colors.

**Known gaps / not built yet:**
- No edit/delete for existing entries — append-only for now.
- The `is_draft` trail flow (drafting a trail before it exists in OSM) has no UI yet —
  today, `getTrailIdentity()` only recognizes features that already exist in the OSM
  vector tiles.
- What to do when clicking something that *doesn't* qualify as a trail (no `mtb:scale`/
  `mtb:name`/`route=mtb`) is explicitly deferred — no "not sure how to handle this yet"
  resolution attempted.
- No standalone "place a marker not tied to any trail" flow — every point-located entry
  today originates from a trail click ("add entry at this point"), so `trail_id` is
  always set in practice even though the schema allows it to be null.
- `find_or_create_location`'s 15m snap radius is a guess, not tuned against real usage
  — if entries meant to be separate keep merging (or ones meant to be the same keep
  splitting), that's the number to revisit.
- A way that belongs to *multiple* same-priority `route=mtb` relations only ever sees
  one of them — `RouteRelationCollector` (`foundation/extract_osm.py`) keeps a single
  `way_id -> relation` mapping, so the second membership is silently dropped at
  extraction time, before it ever reaches the frontend. `getTrailIdentity()`
  (`index.html`) already prioritizes a relation over the clicked way's own identity
  when one relation is present — the not-yet-built part is presenting a picker
  (trail name/length/scale) when a way has *more than one* candidate relation, which
  needs the pipeline change first (list-valued route memberships, propagated through
  the vector tiles). Deferred until it's actually needed with real multi-route data —
  see the comments at both locations above.
- Trail history logged against a way's own identity *before* that way was added to a
  route relation becomes orphaned once `getTrailIdentity()` starts resolving it to the
  relation instead — the old entries just stop showing up anywhere. Not handled
  (acceptable for now since the Supabase project gets wiped before any real deployment).

## Projects: recordings → tracks → review

A planning/staging layer, separate from the OSM-annotation feature above. It lives in
`tracks.js`, kept out of `index.html`'s inline script, with the schema in
`supabase/migrations/0008_recordings_tracks_points.sql`. **0008 replaces 0005–0007's
track model and wipes their data**: those tables were dropped and recreated (test data
only). Projects themselves are kept. Run it in the SQL Editor before deploying the
matching `tracks.js`. OSM stays authoritative for real trails, and nothing here writes
to OSM automatically. **Supersedes** the unfinished `trails.is_draft`/`draft_geometry`
flow.

**Model.** A project's own `id` **is** its share-link capability token. A project holds:
- `recordings`: an uploaded `.fit`/`.gpx`, with the full parsed point list
  `[{lat,lng,ele,time}]` in `points` jsonb. Raw material only, authenticated-only, and
  never exposed to share-link visitors.
- `tracks`: what a project is actually about. `source` is `'recording'` (cut from a
  recording: `recording_id` + inclusive `recording_start_idx`/`recording_end_idx`),
  `'manual'` (drawn) or `'osm_way'` (copied from OSM). `geom` is the working geometry.
  `raw_points` is a frozen copy of the original slice and survives deleting the
  recording (`recording_id` → null). `vertex_origin` is the move-clamp baseline,
  index-aligned with `geom`.
- `project_points` + `project_history`: comments and photos belong to the **project**,
  not a track. Bulk photos are placed in Recordings mode, before the tracks covering
  them necessarily exist. A thread is a point (`point_id`), a whole track (`track_id`),
  or the project in general (neither). Which track a point is "on" is computed
  client-side (nearest within 30 m) and never stored, so it can't go stale as tracks
  are edited, split or deleted. Points with no entries aren't drawn.

**Access model.** Authenticated users get full table access (the same "small trusted
group" RLS as `trails`). Anonymous visitors only go through `security definer` RPCs:
`get_public_project`, `get_public_tracks`, `get_public_project_points`,
`get_public_project_history`, `find_or_create_project_point` and
`add_project_comment`. The last one is the **only** anonymous write path in the schema,
and it checks that the point/track belongs to the given project. Photos live in the
**public** `track-images` bucket under `{project_id}/…`. Anonymous visitors can comment
with text but can't upload photos.

**Modes** (tabs in the project panel; logged-out visitors only ever get Review):
- **Recordings**: upload one or more `.fit`/`.gpx` files, select one, then pick a stretch
  on the elevation profile. The profile sits in the bottom dock (`#recording-dock`), with
  distance on the x axis rather than point index, so stops don't eat width. Drag the
  handles, or click the map near the recording to move the nearer handle. "Extract as
  track" saves the slice. The pick then continues from the end of that stretch, and
  stretches already extracted are shaded on the profile. "Import photos…" opens the
  bulk EXIF matcher against this recording.
- **Tracks**: select a track to start an edit session on it. Drag a point to move it,
  click the line to add a point, click a point to select it, and shift-click another to
  select the stretch between. On the selection: **Remove** (delete the points and join
  the neighbours; at a track end this trims it), **Simplify** (slider + Apply, applied
  to the selection when it spans an interior point, otherwise to the whole track), and
  **Split** (cut at the selection's ends: one point gives 2 tracks, a stretch up to 3).
  Keys: Del removes, Esc deselects, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Ctrl+S saves. Edits
  stay local until **Save**. Split commits immediately, including unsaved edits. Leaving
  a dirty session (switching track or mode, closing the project, unloading the page)
  asks first. "Draw new track" (Enter finishes, Esc cancels) and the OSM popup's "Add to
  project as editable segment" create tracks here too.
- **Review**: the track list with comment counts, plus "Project comments". Click a track
  on the map to open (or create, snapping within 15 m) a point thread there, or click an
  orange marker to open its thread.

**Editor implementation notes:**
- Vertices are a **circle layer** (`track-edit-vertices`), not one DOM marker each, so a
  raw unsimplified track with thousands of points stays usable. Dragging uses
  `mousedown` on that layer plus `e.preventDefault()` to suppress drag-pan, and the
  `mouseup` listener is on `window` so a release outside the canvas still ends the drag.
- Undo/redo stores **whole-array snapshots** (`edit.coords`/`edit.origin`, replaced and
  never mutated per coordinate, so snapshots are shallow copies) rather than per-op
  inverses. That way range operations need no undo logic of their own. It's
  session-scoped and in-memory; there's no persisted edit history.
- **Move-clamp** (`VERTEX_MOVE_CLAMP_M = 300`): a drag is projected back onto a 300 m
  radius around the vertex's `vertex_origin` entry. **Snap** (`SNAP_RADIUS_M = 12`)
  pulls the point to any vertex of the active track or another track in the project
  before the clamp runs.
- **Split** gives each piece its own `raw_points` slice and recording index range,
  found by matching the piece's first/last vertex to the nearest raw point, searched in
  order. If that doesn't come out ordered (e.g. an out-and-back), it falls back to the
  parent's whole range. All pieces' ranges are computed before the parent row is
  mutated.
- Click routing: `tracks.js` has one `map.on('click')` dispatcher (`onMapClick`) and
  exposes `window.tracksWantsMapClick`. `index.html`'s OSM-feature click handler calls
  that first, so no OSM popup opens underneath a click meant for the editor or a project
  track/point. This fixes the old "stray popup while drawing" known gap. To copy an OSM
  way while in Tracks mode, close the track editor first (an active edit session claims
  all clicks).

**Hand-rolled parsers, no CDN libraries** (deliberately, to avoid gambling on an
unverified browser/UMD build):
- **FIT** handles standard record headers and the position/altitude/timestamp base
  types. Developer fields are skipped without desyncing the stream. **Compressed-
  timestamp headers fail** with a clear error. It hasn't been verified against a real
  device file yet, so check the first real import against a known route.
- **GPX** (`parseGpxFile`, via `DOMParser`) reads `<trkpt>`s, with all segments
  concatenated, and falls back to `<rtept>`s for route-only files. `<ele>`/`<time>` are
  optional, so a GPX without times imports fine but disables photo matching for that
  recording. `parseTrackFile` dispatches on file extension and falls back to sniffing
  the `.FIT` signature.
- **EXIF** (`findExifDateTimeOriginal`) prefers the Exif sub-IFD's `DateTimeOriginal`
  over IFD0's `DateTime`. It only reads standard TIFF-in-JPEG (no HEIC). **There's no
  timezone in EXIF**: the matcher treats the clock reading as UTC plus a user-set "camera
  clock offset" (hours). A systematic mismatch across all photos means the offset is
  wrong, not that matching is broken. More than 2 h from any recorded point
  (`BULK_PHOTO_MAX_DELTA_MS`) counts as unmatched, and the photo goes to the project's
  general thread.
- **Simplification** is Ramer–Douglas–Peucker on point *indices*, so surviving points
  are exact originals. Tolerance is in metres via a flat equirectangular approximation,
  which is fine at single-trail scale.

**OSM copies.** `source_osm_way_ids` (every fragment's way-level `osm_id`, never the
relation id) drives a `map.setFilter` that hides those ways from `OSM_TRAIL_LINE_LAYERS`
while the copy exists (`refreshHiddenOsmIds`/`applyHiddenOsmIdsFilter`, reasserted after
style reloads). Known gap: the trail-status overlay/glow layers key off `identity_key`,
not `osm_id`, so they don't hide.

**Export** is client-side only: GPX (with elevation taken from the nearest
`raw_points`), and OSM XML (fresh negative-id nodes + one way with suggested tags; it
never attempts `action="modify"` against the live way, and names the original id for
manual merging in JOSM). Both export the *working* geometry, including unsaved edits.

**Known gaps / not built yet:**
- **Not browser-tested end to end.** The editing logic (select, remove, trim, range
  simplify, undo/redo, save, split incl. raw-slice ranges, extract, profile index
  mapping) passed a Node harness with a stubbed map, DOM and Supabase. The actual mouse
  interaction, rendering and RPCs against the live database haven't been exercised yet.
- No per-project ownership/RLS: any authenticated user can edit any project.
- No UI for browsing all projects; you need the link.
- Anonymous comments have no rate limiting beyond the 2000-character cap.
- No UI to move, merge or delete a `project_point`. Points with no entries are hidden
  but not deleted.
- Bulk photo matching has no per-photo override; only the batch-wide offset.
- Share links don't capture the "Map layers" dropdown state (the old lines/areas
  checkboxes it replaced are skipped).

## Future work (not built yet)

- OSM write-back integration for creating/editing trails from the app (feeds the
  `is_draft` reconciliation flow above) — Projects/Tracks' GPX export is the
  manual-upload stopgap for this
- **Relation builder** — group existing ways into a named `route=mtb` relation
  (builds on the trail segment editor above)
- **Recording gap detection** — flag GPS stretches that don't match any nearby OSM way
  as new-trail candidates (distance-threshold approach, not full map-matching — human
  reviews every candidate before it becomes a segment)
- Route planning UI (admin assembles a route) + GPX/FIT export + a route-description
  render for participants
- "Local trail maintainer group" collaboration model
