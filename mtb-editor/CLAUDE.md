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

## Projects & Tracks (FIT import, trail planning, shareable projects)

A separate planning/staging layer, distinct from the OSM-annotation feature above —
lives in `tracks.js` (kept out of `index.html`'s already-~2000-line inline script) plus
`supabase/migrations/0005_projects_and_tracks.sql`. Built for a concrete workflow:
import a `.fit` file of a scouting walk, cut it into chunks, clean each chunk up,
attach photos/comments, and send a link to a friend to review — without them needing
an account. **Supersedes** the unfinished `trails.is_draft`/`draft_geometry` flow
(above) as the intended path for planning new trails; those columns are untouched but
no longer where new planning work should go. OSM stays authoritative for real trails —
nothing here writes to OSM automatically.

**Schema:** `projects` (a project's own `id` **is** its share-link capability token —
no separate token column, same "unguessable id is the credential" idea as signed image
URLs) → `tracks` (`geom` is the current/working geometry; `raw_points` is the
*immutable* original FIT-imported slice, `[{lat,lng,ele,time}, ...]`, untouched by
simplify/edit) → `track_history` (comment/image entries, same free-form type/value
shape as `trail_history`, but `created_by` is nullable and there's an `author_name` for
anonymous commenters).

**Access model:** authenticated users get full table access (same "small trusted
group, fully open" RLS as `trails`/`trail_history`). Anonymous share-link visitors
never get table grants — they go through `security definer` RPCs instead
(`get_public_project`, `get_public_tracks`, `get_public_track_history`,
`get_public_track_locations`, `get_public_project_locations`,
`find_or_create_track_location`, `add_track_comment`), the last of which is the
**only** anonymous write path anywhere in this schema. `tracks.js` always reads
through these RPCs (works identically logged in or not) and only uses direct table
calls for authenticated-only mutations (create/rename/delete, geometry edits, marking
exported, photo upload). Track photos live in a **public** bucket (`track-images`,
unlike the private `trail-images`) so anon viewers don't need a signed-URL round trip —
anon photo *upload* isn't supported (scope call, easy to revisit): friends can comment
with text, not photos, without an account.

**Point comments/photos (`track_locations`, `supabase/migrations/
0006_track_locations.sql`):** mirrors trails' `locations`/`trail_history.location_id`
design (a comment/photo can be tied to a specific spot, not just "the trail" as a
whole) but as a **separate** table from the trail-side `locations` — that one's RLS is
deliberately authenticated-only, and track comments need anonymous authorship, so
sharing it would have meant widening what the trail-annotation feature exposes.
`track_history.location_id` null is the whole-track thread (opened via the track
editor's "Comments" button); a `track_locations` id is a specific point's thread,
opened by clicking the track's line on the map, clicking an existing point marker
(`track-history-points` layer), or a bulk-matched photo (below).
`find_or_create_track_location` (unlike trails' `find_or_create_location`) is granted
to `anon` too, since clicking a track to leave a comment is exactly the
anonymous-visitor flow this feature exists for.

**Bulk photo upload matched by EXIF timestamp:** `tracks.js` hand-rolls a minimal JPEG
EXIF reader (`findExifDateTimeOriginal`) rather than pulling in a library — same
reasoning as the FIT parser. Walks JPEG segments to the APP1/Exif block, then the
TIFF/IFD structure, preferring the Exif sub-IFD's `DateTimeOriginal` over IFD0's plain
`DateTime`. Each photo's timestamp is matched to the nearest `raw_points[].time` on the
track (only meaningful for `fit_upload` tracks — manual tracks have no recorded times,
so bulk-uploaded photos there always attach to the whole track); beyond
`BULK_PHOTO_MAX_DELTA_MS` (2 hours) a photo counts as unmatched rather than guessed.
**EXIF `DateTimeOriginal` carries no timezone** — the matcher treats the raw clock
reading as UTC and applies a user-adjustable "camera clock offset from UTC" (hours) to
correct it; a systematic mismatch across every photo in the preview list is the tell
that the offset needs adjusting, not that matching is broken. Only reads standard,
uncompressed TIFF-in-JPEG Exif (no HEIC, no maker notes, no orientation handling).

**FIT parsing is hand-rolled** (`tracks.js`, no CDN library) — deliberately, to avoid
gambling on an unverified browser/UMD build of a third-party parser. Handles standard
(non-compressed) record headers and the base types used by position/altitude/timestamp
fields; developer-data fields are skipped (bytes still consumed correctly, so the
stream doesn't desync) but not decoded. **Does not** handle compressed-timestamp FIT
headers (rare in consumer GPS exports) — such a file fails with a clear error rather
than silently producing wrong points. Semicircle→degree and altitude scale/offset
formulas are the standard FIT SDK ones; not verified against a real device file yet
(no sample `.fit` existed in the repo when this was built) — first real import is worth
double-checking against a known route.

**Point editing** is hand-rolled too (draggable `maplibregl.Marker` per vertex,
dblclick to delete, click the line to insert) rather than a drawing library like
`mapbox-gl-draw` — same reasoning (no unverified-compatibility dependency). Practical
for tens of points (i.e. after simplifying); not meant for editing a raw multi-hundred-
point FIT chunk directly.

**Point reduction** is a hand-rolled Ramer–Douglas–Peucker implementation operating on
point *indices* (not reconstructed coordinates), so simplified points are always exact
originals. Tolerance is in metres, via a flat equirectangular approximation (same trick
as the slope-shader math above) — fine at single-trail scale, not geodesically exact.

**Export** is GPX-only (client-side XML generation) plus a suggested-OSM-tags text
blob — no OSM API write-back, matching the "generate exportable data, upload manually
via JOSM/iD" scope decision.

**Known gaps / not built yet:**
- Manual-draw and edit-points map clicks are registered independently of the existing
  OSM-feature click handler in `index.html` — while either mode is active, a stray
  feature popup can still open underneath. Not suppressed (would require exposing
  `index.html`'s `featurePopup` as a global); low-impact, just a minor rough edge.
- No per-project ownership/RLS — any authenticated user can edit any project, same
  "small trusted group" model as trails.
- No UI for browsing *all* public projects — you need the exact link.
- Anonymous comment posting has no rate-limiting/abuse protection beyond the 2000-char
  cap in `add_track_comment`.
- No UI to rename/merge/delete a `track_location` once created (e.g. two nearby clicks
  that should've snapped together but landed just past the 15m radius) — they
  accumulate silently; cascade-deletes with their track, nothing else. Deleting every
  comment/photo at a location does **not** delete the now-empty location row itself
  (same as trails' `locations` — a marker can outlive its history), so an emptied
  point marker stays on the map with an empty thread.
- Comment/photo deletion is authenticated-only (moderation by the trusted maintainer
  group, mirroring trails) — an anonymous visitor can't delete even their own comment,
  since there's no account to prove ownership with.
- Bulk photo EXIF matching has no manual override in the preview list beyond the
  offset-hours field — an individual photo that matched to the wrong point can't be
  reassigned or excluded before upload without changing the offset for the whole batch.

## Trail segment editor (vertex-level editing, OSM import/export)

Foundation for eventually publishing edited/new trails to OSM (manually-reviewed `.osm`
export first, direct API upload possibly later) — see "Future work" below for the two
pieces meant to build on top of this: a relation builder and FIT-track gap detection.
Extends `tracks` (0005) rather than forking a new table — see
`supabase/migrations/0007_track_segments.sql` for the added columns
(`source_osm_type`/`source_osm_id`/`source_osm_way_ids`, `vertex_origin`,
`track_group_id`/`segment_order`) and the regenerated `get_public_tracks`.

**A trail segment IS a track** with `source` now also allowing `'osm_way'` — added via
the OSM popup's "Add to project as editable segment" button (`index.html`, next to the
existing trail-history buttons), which collects every clipped vector-tile fragment
sharing the clicked way/relation identity (same fragment-collection query the gold
selection-glow already uses) and greedily stitches them into one ordered line
(`stitchFragments`, `index.html`) before handing the coordinates to
`tracks.js`'s `window.addTrackFromOsmWay`. Disconnected leftover fragments (outside the
current viewport) are reported, not force-merged — pan closer and re-add if needed.

**Hiding the OSM original once copied**: `source_osm_way_ids` (every fragment's own
way-level `osm_id` — never the relation id, which line features don't carry) drives a
`map.setFilter` excluding those ids from `OSM_TRAIL_LINE_LAYERS`
(`osm-road-casing`/`osm-road-fill`/`osm-track`/`osm-path`) via
`refreshHiddenOsmIds`/`applyHiddenOsmIdsFilter` (`tracks.js`), reasserted after project
open/close, any osm-sourced insert/delete/split, and after style reloads (alongside the
existing `applyOsmVisibility` re-assertion in `map.on('load')`). Known gap: the
trail-status overlay/glow layers key off `identity_key`, not `osm_id` — they don't
automatically hide for a now-edited trail.

**Vertex editing** extends the existing point editor (draggable markers, dblclick to
delete, click-the-line to insert):
- **Move-clamp**: `vertex_origin` (index-aligned with `geom`, set at creation and
  preserved/subset through edits — simplify keeps it in sync via
  `simplifyLngLatWithOrigin`) is the baseline a drag is clamped against
  (`VERTEX_MOVE_CLAMP_M = 300`, projects onto the clamp boundary rather than rejecting
  the move outright). There's no real use case for moving a vertex further than that in
  one drag.
- **Snap**: dragging a vertex within `SNAP_RADIUS_M` (12m) of another vertex — the
  active track's own other vertices, or any other track's, within the *same open
  project* — snaps to it before the clamp check runs. Cross-project snapping and
  snapping to live OSM way points are deferred (OSM polyline points aren't reliable
  trail junctions; worth designing once there's real usage data).
- **Split** ("before"/"after" a vertex — both are `splitAt(N)` under the hood, just
  different N): a `maplibregl.Popup` on a single click of a vertex (not the drag).
  Commits immediately as two DB writes (truncate + insert), **not** part of the undo
  stack — same immediacy class as "Apply"/"Delete track". Both halves keep the same
  `source`/`source_osm_*`/`track_group_id`/`raw_points`; the new tail gets
  `segment_order` = max of its group's existing orders + 1 (not true fractional
  mid-insertion — a simplification worth revisiting if segments get re-split often
  enough for ordering to actually matter).
- **Undo/redo** (`editUndoStack`/`editRedoStack`, `Ctrl+Z`/`Ctrl+Shift+Z` or the
  Undo/Redo buttons): covers move/delete/insert only, in-memory, scoped to the current
  editing session — cleared on save or close, same as the existing "Reset to raw"
  precedent for simplify. No persisted edit-history table; nothing else in this schema
  does server-side geometry history either.

**OSM export** (`trackToOSMXML`/`exportTrailSegmentOSM`, next to `track-export-gpx-btn`):
same "generate exportable data, upload manually via JOSM" scope decision as GPX export —
fresh negative-id nodes + one negative-id way, suggested tags. Deliberately never
attempts `action="modify"`/version reconciliation against a real OSM way (this schema
doesn't track a live OSM version number, which JOSM needs to merge correctly); when
`source_osm_type/id` is set, the post-download alert just names the original id for
manual cross-referencing.

**Not yet browser-tested** — implemented and internally consistency-checked (brace/paren
balance, cross-reference greps, re-verified file:line citations against the actual
files), but this session had no browser tool available to exercise it end-to-end. Test
each piece per the plan's verification section before relying on it:
drag-clamp, undo/redo, split (check both rows in Supabase), OSM import (way disappears
from the base layer, reappears as an editable segment), OSM/GPX export.

## Future work (not built yet)

- OSM write-back integration for creating/editing trails from the app (feeds the
  `is_draft` reconciliation flow above) — Projects/Tracks' GPX export is the
  manual-upload stopgap for this
- **Relation builder** — group existing ways into a named `route=mtb` relation
  (builds on the trail segment editor above)
- **FIT-track gap detection** — flag GPS stretches that don't match any nearby OSM way
  as new-trail candidates (distance-threshold approach, not full map-matching — human
  reviews every candidate before it becomes a segment)
- Route planning UI (admin assembles a route) + GPX/FIT export + a route-description
  render for participants
- "Local trail maintainer group" collaboration model
