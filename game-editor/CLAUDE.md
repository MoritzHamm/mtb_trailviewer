# game-editor/ — POI/Quest Editor (Not Started)

See the repo-root `CLAUDE.md` first for project-wide context. Nothing is built here
yet — this file records the intended shape so work can start directly from it instead
of re-deriving the plan from conversation history. The actual data model lives in
`DATA.md` in this directory; this file covers architecture decisions and status.

## Vision

A schema-constrained level editor for placing POIs that players hunt, quest sequences,
NPC interactions, and mini-games onto the same terrain/OSM map layer the other two
prongs use. A central admin authors this data; players never see this editor — they
receive an exported, Unity-importable "level" package (and possibly a local dump of map
data, or an artistic render of the play area's vicinity).

Key differences from `mtb-editor` (do not copy its patterns uncritically):
- **Capability manifest required**: the editor needs to know what scene types, and
  what enemy/item/minigame content, actually exist before it can let an admin place
  them. See "Capability manifest" below — this is *not* exported from Unity; it's a
  standalone spec both the editor and Unity read. No equivalent concept exists on the
  MTB side.
- **No trail-maintainer-group collaboration model** — that's an MTB-specific concept.
- **Supabase is authoritative here too**, but as a **separate Supabase project** from
  MTB's (clean RLS/access-control separation between what's likely a public-ish trail
  group and a smaller game-authoring team).
- Output is always a **derived export** (Unity level package), never hand-edited —
  same principle as MTB's GPX/route-description exports.

## Data model (see `DATA.md`)

Core concepts, first drafted 2026-07-24:
- **Adventure** — a self-contained game session/dataset. Carries filterable metadata
  (age rating etc.). Adventures don't reference each other's scene/trigger data
  (persistent stats are the one intentional exception — see Stats below).
- **Scene** — has a locality on the map (point, line, or polygon), and two orthogonal
  states: *visibility* (shown on map) and *activation* (will trigger for the player).
  Gameplay type varies (reach-location, puzzle, fight, AR minigame, motion-based
  challenge like flee or red-light/green-light). Completion isn't just a boolean — it
  can carry an outcome value (e.g. which faction's quest branch got taken).
- **Stats** — a set of session-scoped stats (start value, adjusted by player actions,
  multiplies end-of-adventure rewards) and a set of persistent cross-adventure stats
  (coins, reputation). Catalog model (global fixed vs per-adventure freeform) not yet
  decided — see Open questions.
- Deferred, not needed for v1: NPC dialog trees, coop play settings.

## Design decisions made so far

- **Spatial triggering**: GPS is noisy, so don't try to solve precision at the
  geofence level. A scene's locality trigger is a *loose* proximity check — good
  enough to reveal the scene's gameplay. Correctness of "are you actually at the
  target" is enforced separately, by a presence-verification mechanic chosen per
  scene: scanning a QR code, answering a question only answerable on-site ("what
  color is the marking on the rock at the hilltop"), or (later, side-project) matching
  a photo against a pre-recorded reference. This decouples geofence-radius tuning from
  gameplay correctness.
- **Conditions/rules engine deferred**: cross-scene boolean conditions (AND of
  multiple scenes' completion, outcome-dependent branching) are *not* a first-level
  concept yet. Start with unconditional scene chaining — on scene completion, flip
  visibility/activation flags on other named scenes. Revisit conditions once
  unconditional chaining has been used in practice and its limits are clear.
- **Capability manifest is a standalone document, not a Unity export**: neither the
  editor nor Unity is authoritative over the other. Both read the same central spec
  document, which declares what scene types are supported. Basic/generic scene types
  need zero bespoke editor code — their config is rendered generically from the
  manifest. Only complex scene types (e.g. a bespoke puzzle minigame) get concrete,
  hand-written editor implementation, and only once they're actually needed.

## Not yet decided

- Stats catalog: global fixed catalog vs per-adventure freeform, for both session
  stats and persistent stats.
- The manifest document's own format/schema — first draft in progress.
- Quest sequence / NPC interaction data model beyond what's in `DATA.md`.
- Level package export format and how it's imported back into Unity.
- Whether this reuses any of `mtb-editor`'s MapLibre viewer code, or is a separate
  frontend entirely (current lean: separate — the two apps' audiences and edit models
  are different enough that sharing the OSM/terrain *data* layer via `foundation/`
  matters more than sharing UI code).

## Status

`DATA.md` has a first pass at the core data model (adventure/scene/stats). The
capability manifest document is being drafted next. No code, no Supabase schema yet.
