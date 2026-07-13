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

Schema lives at `supabase/migrations/0001_trails_and_history.sql`. No Supabase project
exists yet — setup steps below. Frontend integration (supabase-js, login UI, editor UI
for adding history entries) is not built yet either; this is schema-first.

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

**Setup steps (not done yet):**
1. Create a Supabase project.
2. Run `supabase/migrations/0001_trails_and_history.sql` (SQL Editor, or `supabase db
   push` once the CLI is linked to the project).
3. Enable the email OTP / magic-link auth provider in the project's Auth settings.
4. The Supabase URL + anon key are safe to expose client-side (that's what they're
   for — RLS is the actual security boundary) — add them to `style-config.js` or a
   small dedicated config once the frontend wiring starts.

## Future work (not built yet)

- Frontend Supabase integration: supabase-js, login UI, editor UI for adding/viewing
  history entries, trail list view
- OSM write-back integration for creating/editing trails from the app (feeds the
  `is_draft` reconciliation flow above)
- Route planning UI (admin assembles a route) + GPX/FIT export + a route-description
  render for participants
- "Local trail maintainer group" collaboration model
