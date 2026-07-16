# mtb-editor/ — MTB Trail Viewer/Editor

See the repo-root `CLAUDE.md` first for project-wide context. This directory currently
holds a browser-based terrain/OSM viewer (MapLibre GL JS) — the planned evolution
target is a collaborative MTB trail editor (Supabase-backed trail status/comments, OSM
write-back, route planning + GPX/FIT export), but that layer isn't built yet. What's
here today is the map viewing/rendering foundation that editor will sit on top of.

## Stack

- **MapLibre GL JS v4.4.0** + **PMTiles v3.2.0** (both CDN-loaded via unpkg, no build
  step) — `pmtiles://` protocol registered in `index.html`.
- **pako 2.1.0 + upng-js 2.1.0** (also CDN) — used to decode PNG tile bytes directly,
  bypassing `<canvas>` entirely (see Gotchas).
- `style-config.js` — single source of truth for colors/gradients/opacities
  (`VIEWER_STYLE` object), kept separate from `index.html`'s map wiring so styling can
  be iterated on independently.
- `serve.py`/`serve.sh`/`serve.bat` — local dev server with HTTP Range support (needed
  for PMTiles byte-range fetching) and a remote-tile-proxy fallback (see below).
- `deploy.sh` — pushes static assets + tiles to Cloudflare R2.

## Tile files

`tiles/` is gitignored (large binaries). Expected contents when fully populated:
`dalarna.pmtiles` (OSM vector layers), `terrain.pmtiles` (terrain-RGB elevation, symlink
to `/mnt/g/lidar-output/terrain.pmtiles` on the desktop), `overlay.pmtiles` (retired —
see `foundation/CLAUDE.md`), `coverage.geojson` (mask showing what area has real data).
On a fresh checkout (e.g. a laptop), this directory may have little or nothing in it —
that's expected, see the tile-proxy section below.

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

## Canvas premultiplied-alpha bug (why UPNG.js exists here)

Overlay channels pack real data into the PNG **alpha** channel (wetness — see
`foundation/generate_overlay_tiles.py`), not real transparency. `<canvas>` surfaces
store pixels premultiplied by alpha internally regardless of compositing mode, so any
pixel with alpha=0 permanently loses its RGB the instant it's drawn — this silently
zeroed out CHM/vegetation-height data wherever wetness happened to be 0. Fixed by
decoding PNG bytes directly via `UPNG.decode()`/`UPNG.toRGBA8()` (pako-backed),
bypassing `createImageBitmap`/`OffscreenCanvas`/`getImageData` entirely. Do not
reintroduce a canvas-based decode path for any tile carrying non-transparency data in
alpha.

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

## Future work (not built yet)

- Frontend Supabase integration: supabase-js, login UI, editor UI for adding/viewing
  history entries, trail list view
- OSM write-back integration for creating/editing trails from the app (feeds the
  `is_draft` reconciliation flow above)
- Route planning UI (admin assembles a route) + GPX/FIT export + a route-description
  render for participants
- "Local trail maintainer group" collaboration model
