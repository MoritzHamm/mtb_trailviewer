// Visual/styling constants for the terrain viewer.
//
// Kept separate from index.html's map wiring and interaction logic so colors,
// gradients, and OSM feature styling can be iterated on independently — e.g.
// eventually moving OSM rendering toward an orienteering-map symbol style
// without having to dig through map/event-handling code to find them.

const VIEWER_STYLE = {
  background: {
    solid: '#2a2e35',
  },

  // Initial hillshade paint — immediately overridden by updateHillshade()/
  // applyAltitude() on load based on restored slider settings, but kept here
  // as the single source of truth for the style layer's starting values.
  hillshade: {
    illuminationDirection: 315,
    exaggeration: 0.6,
    shadowColor: '#2a2a3a',
    highlightColor: '#fffbe8',

    // applyAltitude() maps the altitude slider (0=low sun, 1=high sun) to
    // these HSL lightness ranges. Both need to be wide: a narrow band near
    // white/black is imperceptible, which is why sun-facing slopes used to
    // blow out to white at every altitude (highlight lightness was pinned to
    // 95-99% regardless of the slider) while shadows never got dark enough
    // to balance it out.
    altitudeResponse: {
      shadowHue: 240, shadowSat: 15, shadowLightMin: 8,  shadowLightMax: 40,
      highlightHue: 45, highlightSat: 30, highlightLightMin: 55, highlightLightMax: 90,
    },
  },

  // Slope color ramp, anchored in degrees (what's actually computed from the
  // terrain-RGB tiles) but chosen for cycling relevance rather than an even
  // spread across 0-50°: nearly-flat ground stays blue through a full degree,
  // ramps to orange by 5° (~8.7% grade), to red by 25% grade (~14.0°), to
  // violet by 100% grade (45°, "wall" steep) and clamps there.
  slope: {
    stops: [
      { deg: 0,                               color: [33, 102, 224] },  // blue — flat
      { deg: 1,                               color: [33, 102, 224] },  // still flat-blue to 1°
      { deg: 5,                               color: [255, 140, 0] },   // orange by 5°
      { deg: Math.atan(0.25) * 180 / Math.PI, color: [220, 30, 30] },   // red by 25% grade
      { deg: Math.atan(1)    * 180 / Math.PI, color: [154, 30, 200] },  // violet by 100% grade
    ],
  },

  // Overlay channel ramps — see generate_overlay_tiles.py (B=CHM, A=wetness)
  wetness:   { colorLow: [168, 138, 91],  colorHigh: [27, 79, 114] },  // dry tan → wet blue
  vegheight: { colorLow: [194, 178, 128], colorHigh: [18, 63, 18] },   // bare tan → dark canopy green

  // Selected-feature highlight (click a trail/road/etc.) — bright gold glow,
  // similar to OSM's own iD editor selection style. Two stacked line layers:
  // a wide blurred outer glow + a narrower, crisper core on top of it.
  selection: {
    color: '#fff700',
    glowWidth: 16, glowOpacity: 0.35, glowBlur: 3,
    coreWidth: 5,  coreOpacity: 0.9,  coreBlur: 0.5,
  },

  coverage: {
    maskColor: '#888888', maskOpacity: 0.35,
    borderColor: '#ff7733',
  },

  osm: {
    landuse: {
      match: [
        'forest', '#2d4a2d', 'wood', '#2d4a2d',
        'farmland', '#6b7a3a', 'meadow', '#4a6b3a',
        'wetland', '#3a5a6b', 'heath', '#5a4a3a',
      ],
      fallback: '#333',
      opacity: 0.35,
    },
    water:     { color: '#2a5f7a', opacity: 0.7 },
    buildings: { color: '#555',    opacity: 0.6 },
    roadCasing: { color: '#222', opacity: 0.7 },
    roadFill:   { color: '#fff', opacity: 0.85 },
    track:      { color: '#d4a853', opacity: 0.9 },
    path: {
      opacity: 0.95,
      mtbScale: {
        match: ['0', '#4caf50', '1', '#2196f3', '1+', '#1565c0', '2', '#e53935', '3', '#880e4f'],
        fallback: '#aaaaaa',
      },
    },
    waterway:     { color: '#5ab4d4', opacity: 0.85 },
    railway:      { color: '#888' },
    power:        { color: '#cc0', opacity: 0.5 },
    naturalLines: { color: '#a0522d', opacity: 0.8 },
    places:       { textColor: '#fff', haloColor: '#222' },
    peak:         { color: '#ff8c00' },
  },

  // Trail status overlay (Supabase trail_history, entry_type='status') — drawn as a
  // colored line under the trail itself, only for non-clear statuses (a clear trail
  // just looks like a normal trail, no overlay needed).
  trailStatus: {
    overgrown:          '#e0b400',
    partially_blocked:  '#e0791e',
    fully_blocked:      '#d43d3d',
    width: 5, opacity: 0.85,
  },

  // History entries with a point location (windfall pins etc.) — small markers,
  // colored by entry type.
  historyPoint: {
    status:  '#e0791e',
    comment: '#5ba4cf',
    image:   '#9a5ec8',
    radius: 6, strokeColor: '#1a1a1a', strokeWidth: 1.5,
  },
};
