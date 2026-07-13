# game-editor/ — POI/Quest Editor (Not Started)

See the repo-root `CLAUDE.md` first for project-wide context. Nothing is built here
yet — this file records the intended shape so work can start directly from it instead
of re-deriving the plan from conversation history.

## Vision

A schema-constrained level editor for placing POIs that players hunt, quest sequences,
NPC interactions, and mini-games onto the same terrain/OSM map layer the other two
prongs use. A central admin authors this data; players never see this editor — they
receive an exported, Unity-importable "level" package (and possibly a local dump of map
data, or an artistic render of the play area's vicinity).

Key differences from `mtb-editor` (do not copy its patterns uncritically):
- **Capability manifest required**: the game editor needs to know what enemy/item/
  minigame types actually exist in the Unity project before it can let an admin place
  them. This manifest is exported *from* Unity into the editor — the editor's palette
  of placeable things is derived, not hardcoded. No equivalent concept exists on the
  MTB side.
- **No trail-maintainer-group collaboration model** — that's an MTB-specific concept.
- **Supabase is authoritative here too**, but as a **separate Supabase project** from
  MTB's (clean RLS/access-control separation between what's likely a public-ish trail
  group and a smaller game-authoring team).
- Output is always a **derived export** (Unity level package), never hand-edited —
  same principle as MTB's GPX/route-description exports.

## Not yet decided (resolve when work actually starts here)

- Unity capability manifest format (JSON? versioned? how does the editor detect a
  manifest update from a newer Unity build?)
- Quest sequence / NPC interaction data model
- Level package export format and how it's imported back into Unity
- Whether this reuses any of `mtb-editor`'s MapLibre viewer code, or is a separate
  frontend entirely (current lean: separate — the two apps' audiences and edit models
  are different enough that sharing the OSM/terrain *data* layer via `foundation/`
  matters more than sharing UI code)

## Status

Empty scaffold only. First real work should probably be: decide the capability
manifest format with the Unity project side, then stand up the Supabase project/schema.
