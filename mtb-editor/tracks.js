// ---------------------------------------------------------------------------
// Projects & Tracks — FIT import/chunking, manual trail drawing, point
// simplification, and shareable planning projects. Kept out of index.html's
// already-~2000-line inline script since it's a largely self-contained feature.
// Loaded last (see index.html) so `map`/`sb`/`currentSession`/`escapeHtml`/
// `VIEWER_STYLE` already exist as globals — no module system, matches this
// project's no-build-step convention everywhere else.
//
// See supabase/migrations/0005_projects_and_tracks.sql for the schema and
// mtb-editor/CLAUDE.md for the design writeup.
//
// Reading: authenticated users query `projects`/`tracks`/`track_history`
// directly (RLS: any authenticated user, full access — same "small trusted
// group" model as trails/trail_history). Everyone else (including a logged-in
// user just *viewing* a shared project) reads through the get_public_*
// security-definer RPCs instead, which work identically whether or not a
// session exists — so this file always uses those for display, and only
// switches to direct table calls for the authenticated-only mutations
// (create/rename/delete project or track, edit geometry, mark exported,
// upload a photo). Anonymous comments go through the add_track_comment RPC,
// the one write path that doesn't require a session at all.
// ---------------------------------------------------------------------------

let currentProject = null;      // { id, name, description, created_at } | null
let currentTracks = [];         // [{ id, name, source, geojson, coords, raw_points, simplify_tolerance_m, is_exported, created_at }]
let activeTrackId = null;

let editingPoints = false;
let editVertexMarkers = [];
let editWorkingCoords = [];

let manualDrawActive = false;
let manualDrawCoords = [];
let manualDrawMarkers = [];

let fitRecords = null;          // [{ lat, lng, ele, time }] parsed from the uploaded .fit
let fitChunkStart = 0;
let fitChunkEnd = 0;
let fitDraggingHandle = null;   // 'start' | 'end' | null

let commentsTrackId = null;
let commentsLocationId = null;   // null = whole-track thread; a track_locations id = a specific point
const trackHistoryImagePaths = new Map();   // entryId -> storage path, for cleaning up the file on delete (repopulated each refreshTrackComments)

let currentLocations = [];       // [{ id, track_id, geojson, label }] — every point comment/photo marker in the open project

let bulkPhotoTrackId = null;
let bulkPhotoMatches = [];       // [{ file, matchedTime, point, distanceMs }] after "Match photos"

// ---------------------------------------------------------------------------
// Minimal FIT binary parser
// ---------------------------------------------------------------------------
// Just enough of the FIT format (Garmin's binary activity/track format) to pull
// GPS record points out of a walk/ride recording — no external library, so no
// CDN dependency whose browser/UMD compatibility we'd have to gamble on (see
// mtb-editor/CLAUDE.md for why this was chosen over a packaged parser). Handles
// the common case: standard (non-compressed) record headers, the base types
// actually used by position/altitude/timestamp fields, and developer-data
// fields (skipped, not decoded, but their bytes are still correctly consumed
// so the stream doesn't desync). Does NOT handle compressed-timestamp headers
// (rare in consumer GPS exports) — files using them fail with a clear error
// rather than silently producing wrong points.
const FIT_EPOCH_OFFSET_SEC = 631065600; // seconds between 1970-01-01 and the FIT epoch (1989-12-31T00:00:00Z)
const FIT_MESG_RECORD = 20;
const FIT_FIELD_LAT = 0, FIT_FIELD_LONG = 1, FIT_FIELD_ALTITUDE = 2, FIT_FIELD_ENHANCED_ALTITUDE = 78, FIT_FIELD_TIMESTAMP = 253;

// byteValue -> { size, read(dataView, offset, littleEndian) }. Values/sizes are
// the standard FIT SDK base-type table. Alignment through the data stream
// never depends on this lookup being complete — every field advances the
// cursor by its *declared* size regardless of whether we recognise its type.
const FIT_BASE_TYPES = {
  0x00: { size: 1, read: (dv, o) => dv.getUint8(o) },              // enum
  0x01: { size: 1, read: (dv, o) => dv.getInt8(o) },                // sint8
  0x02: { size: 1, read: (dv, o) => dv.getUint8(o) },               // uint8
  0x83: { size: 2, read: (dv, o, le) => dv.getInt16(o, le) },       // sint16
  0x84: { size: 2, read: (dv, o, le) => dv.getUint16(o, le) },      // uint16
  0x85: { size: 4, read: (dv, o, le) => dv.getInt32(o, le) },       // sint32
  0x86: { size: 4, read: (dv, o, le) => dv.getUint32(o, le) },      // uint32
  0x07: { size: 1, read: (dv, o) => dv.getUint8(o) },               // string (byte array)
  0x88: { size: 4, read: (dv, o, le) => dv.getFloat32(o, le) },     // float32
  0x89: { size: 8, read: (dv, o, le) => dv.getFloat64(o, le) },     // float64
  0x0A: { size: 1, read: (dv, o) => dv.getUint8(o) },               // uint8z
  0x8B: { size: 2, read: (dv, o, le) => dv.getUint16(o, le) },      // uint16z
  0x8C: { size: 4, read: (dv, o, le) => dv.getUint32(o, le) },      // uint32z
  0x0D: { size: 1, read: (dv, o) => dv.getUint8(o) },               // byte
};
const FIT_FALLBACK_TYPE = FIT_BASE_TYPES[0x0D];

function parseFitFile(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 14) throw new Error('file too small to be a valid FIT file');
  const headerSize = dv.getUint8(0);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== '.FIT') throw new Error('missing ".FIT" signature — not a FIT file');
  const dataSize = dv.getUint32(4, true);
  const dataEnd = headerSize + dataSize;

  let offset = headerSize;
  const localDefs = {};   // localMsgType -> { globalMesgNum, littleEndian, fields: [{num,size,baseType,developer}] }
  const records = [];
  const SEMICIRCLE_TO_DEG = 180 / 2147483648; // 180 / 2^31

  while (offset < dataEnd) {
    const headerByte = dv.getUint8(offset); offset += 1;
    if (headerByte & 0x80) {
      throw new Error('compressed-timestamp FIT headers are not supported by this importer');
    }
    const localType = headerByte & 0x0F;
    const isDefinition = (headerByte & 0x40) !== 0;

    if (isDefinition) {
      offset += 1; // reserved
      const littleEndian = dv.getUint8(offset) === 0; offset += 1;
      const globalMesgNum = dv.getUint16(offset, littleEndian); offset += 2;
      const fieldCount = dv.getUint8(offset); offset += 1;
      const fields = [];
      for (let i = 0; i < fieldCount; i++) {
        fields.push({ num: dv.getUint8(offset), size: dv.getUint8(offset + 1), baseType: dv.getUint8(offset + 2) });
        offset += 3;
      }
      // Developer fields (has_developer_data flag) — not decoded, just kept in
      // the field list (with their real size) so data messages still advance
      // the cursor correctly.
      if (headerByte & 0x20) {
        const devCount = dv.getUint8(offset); offset += 1;
        for (let i = 0; i < devCount; i++) {
          fields.push({ num: -1, size: dv.getUint8(offset + 1), baseType: 0x0D, developer: true });
          offset += 3;
        }
      }
      localDefs[localType] = { globalMesgNum, littleEndian, fields };
    } else {
      const def = localDefs[localType];
      if (!def) throw new Error('malformed FIT file: data message with no prior definition');
      let lat = null, lng = null, altitude = null, enhancedAltitude = null, timestamp = null;
      for (const f of def.fields) {
        if (def.globalMesgNum === FIT_MESG_RECORD && !f.developer) {
          const type = FIT_BASE_TYPES[f.baseType] || FIT_FALLBACK_TYPE;
          const v = type.read(dv, offset, def.littleEndian);
          if (f.num === FIT_FIELD_LAT) lat = v;
          else if (f.num === FIT_FIELD_LONG) lng = v;
          else if (f.num === FIT_FIELD_ALTITUDE) altitude = v;
          else if (f.num === FIT_FIELD_ENHANCED_ALTITUDE) enhancedAltitude = v;
          else if (f.num === FIT_FIELD_TIMESTAMP) timestamp = v;
        }
        offset += f.size; // always the declared size — keeps the stream aligned even for fields we ignore or don't understand
      }
      if (def.globalMesgNum === FIT_MESG_RECORD && lat != null && lng != null && lat !== 0x7FFFFFFF && lng !== 0x7FFFFFFF) {
        const ele = (enhancedAltitude != null && enhancedAltitude !== 0xFFFFFFFF) ? enhancedAltitude / 5 - 500
          : (altitude != null && altitude !== 0xFFFF) ? altitude / 5 - 500
          : null;
        records.push({
          lat: lat * SEMICIRCLE_TO_DEG,
          lng: lng * SEMICIRCLE_TO_DEG,
          ele,
          time: timestamp != null ? (timestamp + FIT_EPOCH_OFFSET_SEC) * 1000 : null,
        });
      }
    }
  }
  if (!records.length) throw new Error('no GPS record points found in this FIT file');
  return records;
}

// ---------------------------------------------------------------------------
// Minimal JPEG EXIF DateTimeOriginal reader — for matching bulk-uploaded photos
// to a point on a FIT-imported track by timestamp. Hand-rolled for the same
// reason as the FIT parser above: no CDN library whose browser compatibility
// needs verifying. Walks JPEG segments to find APP1 (Exif), then the TIFF/IFD
// structure inside it, preferring the Exif sub-IFD's DateTimeOriginal (0x9003)
// over IFD0's plain DateTime (0x0132) when both exist. Returns the raw
// "YYYY:MM:DD HH:MM:SS" string (no timezone — EXIF doesn't reliably carry one),
// or null if the file isn't a JPEG or has no parseable timestamp.
// ---------------------------------------------------------------------------
function readExifIFD(dv, tiffStart, ifdOffset, little) {
  const count = dv.getUint16(ifdOffset, little);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    entries.push({
      tag: dv.getUint16(entryOffset, little),
      type: dv.getUint16(entryOffset + 2, little),
      numValues: dv.getUint32(entryOffset + 4, little),
      valueOffset: entryOffset + 8,
    });
  }
  return entries;
}

// ASCII EXIF fields (type 2): 1 byte/char, inline if <=4 bytes total, else a
// 4-byte offset (from the TIFF header) to where the string actually lives.
function readExifAscii(dv, tiffStart, entry, little) {
  const len = entry.numValues;
  const dataStart = len <= 4 ? entry.valueOffset : tiffStart + dv.getUint32(entry.valueOffset, little);
  let str = '';
  for (let i = 0; i < len; i++) {
    const b = dv.getUint8(dataStart + i);
    if (b === 0) break;
    str += String.fromCharCode(b);
  }
  return str;
}

function findExifDateTimeOriginal(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null; // not a JPEG (SOI marker)

  let offset = 2;
  while (offset < dv.byteLength - 4) {
    if (dv.getUint8(offset) !== 0xFF) break;
    const marker = dv.getUint8(offset + 1);
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; } // no-payload markers
    if (marker === 0xDA) break; // start of scan — image data follows, no more metadata segments

    const segLen = dv.getUint16(offset + 2);
    if (marker === 0xE1) { // APP1 — where Exif lives
      const segStart = offset + 4;
      const isExif = dv.getUint8(segStart) === 0x45 && dv.getUint8(segStart + 1) === 0x78
        && dv.getUint8(segStart + 2) === 0x69 && dv.getUint8(segStart + 3) === 0x66; // "Exif"
      if (isExif) {
        const tiffStart = segStart + 6; // skip "Exif\0\0"
        const byteOrder = dv.getUint16(tiffStart);
        if (byteOrder === 0x4949 || byteOrder === 0x4D4D) { // 'II' little-endian / 'MM' big-endian
          const little = byteOrder === 0x4949;
          const ifd0Offset = tiffStart + dv.getUint32(tiffStart + 4, little);
          const ifd0 = readExifIFD(dv, tiffStart, ifd0Offset, little);

          let dateTime = null, exifIFDOffset = null;
          for (const e of ifd0) {
            if (e.tag === 0x0132 && e.type === 2) dateTime = readExifAscii(dv, tiffStart, e, little); // DateTime (fallback)
            if (e.tag === 0x8769) exifIFDOffset = dv.getUint32(e.valueOffset, little); // pointer to Exif sub-IFD
          }
          if (exifIFDOffset != null) {
            const exifIFD = readExifIFD(dv, tiffStart, tiffStart + exifIFDOffset, little);
            for (const e of exifIFD) {
              if (e.tag === 0x9003 && e.type === 2) { dateTime = readExifAscii(dv, tiffStart, e, little); break; } // DateTimeOriginal wins
            }
          }
          if (dateTime) return dateTime;
        }
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

// "YYYY:MM:DD HH:MM:SS" (camera-local time, no timezone) -> epoch ms, treating
// the naive clock reading as UTC and then applying offsetHours (the camera
// clock's actual UTC offset) to correct it — this is the best any EXIF-based
// matching can do without extra input, since plain DateTimeOriginal carries no
// zone. Wrong offset guesses show up as a systematic mismatch in the preview
// list (every photo the same distance/time off), which is the cue to adjust it.
function exifDateTimeToMs(str, offsetHours) {
  const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [Y, Mo, D, H, Mi, S] = m.slice(1).map(Number);
  return Date.UTC(Y, Mo - 1, D, H, Mi, S) - offsetHours * 3600000;
}

// ---------------------------------------------------------------------------
// Geometry helpers — Ramer-Douglas-Peucker simplification (index-based, so the
// surviving points are exact originals, never reconstructed coordinates) and a
// planar nearest-segment lookup for click-to-insert-a-vertex. Both work at the
// scale of a single trail (a few km at most), so a simple equirectangular
// metres approximation (same trick as the slope-shader math in index.html) is
// accurate enough — no need for anything geodesic.
// ---------------------------------------------------------------------------
function metersPerDegreeAt(lat) {
  const latRad = lat * Math.PI / 180;
  return { mLng: 111320 * Math.cos(latRad), mLat: 110540 };
}

function perpDistMeters(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function rdpKeepIndices(pts, startIdx, endIdx, toleranceM, keep) {
  let maxDist = 0, splitIdx = -1;
  const a = pts[startIdx], b = pts[endIdx];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const d = perpDistMeters(pts[i], a, b);
    if (d > maxDist) { maxDist = d; splitIdx = i; }
  }
  if (splitIdx !== -1 && maxDist > toleranceM) {
    rdpKeepIndices(pts, startIdx, splitIdx, toleranceM, keep);
    keep.add(splitIdx);
    rdpKeepIndices(pts, splitIdx, endIdx, toleranceM, keep);
  }
}

// coords: [[lng,lat], ...]. Returns a new array of the same shape, always
// keeping the first/last point.
function simplifyLngLat(coords, toleranceM) {
  if (coords.length < 3 || toleranceM <= 0) return coords.slice();
  const mpd = metersPerDegreeAt(coords[0][1]);
  const meters = coords.map(c => [c[0] * mpd.mLng, c[1] * mpd.mLat]);
  const keep = new Set([0, coords.length - 1]);
  rdpKeepIndices(meters, 0, coords.length - 1, toleranceM, keep);
  return [...keep].sort((x, y) => x - y).map(i => coords[i]);
}

function pointToSegmentDistSq(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * dx, py = a[1] + t * dy;
  return (p[0] - px) ** 2 + (p[1] - py) ** 2;
}

// Which segment [i, i+1] a click landed nearest to — used to decide where a
// newly-inserted vertex goes. Plain degree-space comparison (not metres) is
// fine here: only the *relative* ordering of distances matters, not their
// absolute size.
function nearestSegmentIndex(coords, pt) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDistSq(pt, coords[i], coords[i + 1]);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function toEWKT(coords) {
  return 'LINESTRING(' + coords.map(c => `${c[0]} ${c[1]}`).join(',') + ')';
}

// ---------------------------------------------------------------------------
// Map sources/layers
// ---------------------------------------------------------------------------
function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
function lineFeature(coords, props) { return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props || {} }; }

function registerMapLayers() {
  map.addSource('project-tracks', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'project-tracks-line', type: 'line', source: 'project-tracks',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      // Manual sketches get their own color; imported chunks are 'proposed'
      // (purple) until marked exported (green) — see VIEWER_STYLE.tracks.
      'line-color': ['match', ['get', 'source'],
        'manual', VIEWER_STYLE.tracks.manual.color,
        ['case', ['==', ['get', 'is_exported'], true], VIEWER_STYLE.tracks.exported.color, VIEWER_STYLE.tracks.proposed.color],
      ],
      'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [2, 1],
    },
  });

  map.addSource('fit-import-full', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'fit-import-full-line', type: 'line', source: 'fit-import-full',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': VIEWER_STYLE.tracks.rawImport.color, 'line-width': VIEWER_STYLE.tracks.rawImport.width,
      'line-opacity': VIEWER_STYLE.tracks.rawImport.opacity, 'line-dasharray': VIEWER_STYLE.tracks.rawImport.dasharray,
    },
  });

  map.addSource('fit-import-chunk', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'fit-import-chunk-line', type: 'line', source: 'fit-import-chunk',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': VIEWER_STYLE.tracks.chunkPick.color, 'line-width': VIEWER_STYLE.tracks.chunkPick.width,
      'line-opacity': VIEWER_STYLE.tracks.chunkPick.opacity,
    },
  });

  // Shared live-preview line for both "edit points" mode and manual drawing —
  // the two are mutually exclusive (only one active at a time), so one source
  // covers both.
  map.addSource('track-edit-line', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'track-edit-line-layer', type: 'line', source: 'track-edit-line',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': VIEWER_STYLE.tracks.chunkPick.color, 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [1, 1] },
  });

  // Click the preview line while editing to insert a vertex at that point —
  // only active during editingPoints (manual-draw adds points via the
  // generic map click handler registered in startManualDraw's caller below,
  // since there's no line to click until at least 2 points exist).
  map.on('click', 'track-edit-line-layer', e => {
    if (!editingPoints) return;
    const clickLngLat = [e.lngLat.lng, e.lngLat.lat];
    const insertAt = nearestSegmentIndex(editWorkingCoords, clickLngLat);
    editWorkingCoords.splice(insertAt + 1, 0, clickLngLat);
    rebuildEditMarkers();
  });

  // Manual-draw points — registered once, checks state internally (same
  // pattern as index.html's other always-on handlers, e.g. history-points).
  map.on('click', e => {
    if (manualDrawActive) addManualDrawPoint(e.lngLat);
  });

  // Point comments/photos (track_locations) — small markers, same idea as
  // index.html's own 'history-points' layer for trails.
  map.addSource('track-history-points', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'track-history-points-layer', type: 'circle', source: 'track-history-points',
    paint: {
      'circle-radius': VIEWER_STYLE.tracks.locationPoint.radius,
      'circle-color': VIEWER_STYLE.tracks.locationPoint.color,
      'circle-stroke-color': VIEWER_STYLE.tracks.locationPoint.strokeColor,
      'circle-stroke-width': VIEWER_STYLE.tracks.locationPoint.strokeWidth,
    },
  });
  map.on('click', 'track-history-points-layer', e => {
    const f = e.features[0];
    const track = currentTracks.find(t => t.id === f.properties.track_id);
    if (track) openTrackComments(track, f.properties.id);
  });
  map.on('mouseenter', 'track-history-points-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'track-history-points-layer', () => { map.getCanvas().style.cursor = ''; });

  // Click a track's own line (not an existing point marker) to comment/attach a
  // photo at that specific spot — skipped while drawing/editing, since a click
  // there means something else entirely.
  map.on('click', 'project-tracks-line', e => {
    if (manualDrawActive || editingPoints) return;
    const track = currentTracks.find(t => t.id === e.features[0].properties.id);
    if (track) openTrackCommentsAtPoint(track, e.lngLat.lng, e.lngLat.lat);
  });
  map.on('mouseenter', 'project-tracks-line', () => { if (!manualDrawActive && !editingPoints) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'project-tracks-line', () => { map.getCanvas().style.cursor = ''; });
}

function refreshProjectTracksSource() {
  const src = map.getSource('project-tracks');
  if (!src) return;
  const features = currentTracks
    // Hide whichever track is actively being point-edited — the live preview
    // on track-edit-line stands in for it instead.
    .filter(t => !(editingPoints && t.id === activeTrackId))
    .map(t => lineFeature(t.coords, { id: t.id, source: t.source, is_exported: !!t.is_exported }));
  src.setData({ type: 'FeatureCollection', features });
}

function refreshProjectLocationsSource() {
  const src = map.getSource('track-history-points');
  if (!src) return;
  const features = currentLocations.map(l => ({
    type: 'Feature', geometry: l.geojson, properties: { id: l.id, track_id: l.track_id },
  }));
  src.setData({ type: 'FeatureCollection', features });
}

// Adds a just-touched location to the in-memory list without a re-fetch (we
// already know its id/coords from whatever just created or resolved it) —
// no-ops if it's already known, since find_or_create_track_location may have
// resolved to a pre-existing location rather than a new one.
function ensureLocalLocation(id, trackId, lng, lat) {
  if (currentLocations.some(l => l.id === id)) return;
  currentLocations.push({ id, track_id: trackId, geojson: { type: 'Point', coordinates: [lng, lat] }, label: null });
  refreshProjectLocationsSource();
}

function setEditLineSource(coords) {
  const src = map.getSource('track-edit-line');
  if (src) src.setData(coords && coords.length >= 2 ? { type: 'FeatureCollection', features: [lineFeature(coords)] } : emptyFC());
}
function clearEditLineSource() { setEditLineSource(null); }

function setFitImportFullSource() {
  const src = map.getSource('fit-import-full');
  if (src) src.setData({ type: 'FeatureCollection', features: [lineFeature(fitRecords.map(r => [r.lng, r.lat]))] });
}
function updateFitChunkSource() {
  const src = map.getSource('fit-import-chunk');
  if (src) src.setData({ type: 'FeatureCollection', features: [lineFeature(fitRecords.slice(fitChunkStart, fitChunkEnd + 1).map(r => [r.lng, r.lat]))] });
}
function clearFitImportSources() {
  ['fit-import-full', 'fit-import-chunk'].forEach(id => { const s = map.getSource(id); if (s) s.setData(emptyFC()); });
}

function fitMapToCoords(coords) {
  if (!coords.length) return;
  let minLng = coords[0][0], maxLng = coords[0][0], minLat = coords[0][1], maxLat = coords[0][1];
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 600, maxZoom: 16 });
}
function fitMapToTracks() {
  const all = currentTracks.flatMap(t => t.coords);
  if (all.length) fitMapToCoords(all);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
async function loadMyProjects() {
  const sel = document.getElementById('project-select');
  sel.innerHTML = '<option value="">— open a project —</option>';
  if (!currentSession) return;
  const { data, error } = await sb.from('projects').select('id,name').order('created_at', { ascending: false });
  if (error) { console.error(error); return; }
  for (const p of data) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    sel.appendChild(opt);
  }
}

// opts.fitView: false skips the auto fit-to-tracks camera move — used when the
// link already carries an explicit saved view (see applyViewParamsFromURL), so
// that view isn't immediately overridden by an auto-fit.
//
// Wrapped in try/catch end-to-end (not just around the first RPC call) —
// previously an exception anywhere after the initial fetch (e.g. while mapping
// track rows) failed completely silently: no alert, no console output, the
// panel just never left the "open a project" state with no sign anything had
// gone wrong. If this still fails to open a project, check the browser
// console — the error is now always logged there at minimum.
async function openProject(id, opts = {}) {
  try {
    const { data: proj, error } = await sb.rpc('get_public_project', { p_id: id }).single();
    if (error || !proj) { console.error(error); alert('Could not load that project — check the link.'); return; }
    const { data: tracks, error: tErr } = await sb.rpc('get_public_tracks', { p_project_id: id });
    if (tErr) console.error(tErr);
    const { data: locations, error: lErr } = await sb.rpc('get_public_project_locations', { p_project_id: id });
    if (lErr) console.error(lErr);

    currentProject = proj;
    currentTracks = (tracks || []).map(t => ({ ...t, coords: t.geojson.coordinates }));
    currentLocations = locations || [];
    activeTrackId = null;
    stopEditingPoints(false);

    renderProjectActive();
    renderTrackList();
    refreshProjectTracksSource();
    refreshProjectLocationsSource();
    if (opts.fitView !== false) fitMapToTracks();

    const url = new URL(location.href);
    url.searchParams.set('project', id);
    history.replaceState(null, '', url);
  } catch (err) {
    console.error('openProject failed', err);
    alert(`Could not open that project: ${err.message}`);
  }
}

function closeProject() {
  currentProject = null;
  currentTracks = [];
  currentLocations = [];
  activeTrackId = null;
  stopEditingPoints(false);
  closeTrackEditor();
  renderProjectActive();
  renderTrackList();
  refreshProjectTracksSource();
  refreshProjectLocationsSource();

  const url = new URL(location.href);
  url.searchParams.delete('project');
  history.replaceState(null, '', url);
}

function renderProjectActive() {
  document.getElementById('projects-picker').style.display = currentProject ? 'none' : 'block';
  document.getElementById('project-active').style.display = currentProject ? 'block' : 'none';
  if (!currentProject) return;
  document.getElementById('project-active-name').textContent = currentProject.name;
  document.getElementById('project-active-desc').textContent = currentProject.description || '';
  document.getElementById('track-owner-controls').style.display = currentSession ? 'block' : 'none';
}

function renderTrackList() {
  const ul = document.getElementById('track-list');
  ul.innerHTML = '';
  for (const t of currentTracks) {
    const li = document.createElement('li');
    li.className = t.id === activeTrackId ? 'active' : '';
    const badgeStyle = t.source === 'manual' ? VIEWER_STYLE.tracks.manual
      : t.is_exported ? VIEWER_STYLE.tracks.exported : VIEWER_STYLE.tracks.proposed;
    li.innerHTML = `<span>${escapeHtml(t.name || '(untitled)')}</span>` +
      `<span class="track-badge" style="background:${badgeStyle.color}">${t.is_exported ? 'exported' : t.source}</span>`;
    li.addEventListener('click', () => selectTrack(t.id));
    ul.appendChild(li);
  }
}

function activeTrack() { return currentTracks.find(t => t.id === activeTrackId); }

function selectTrack(id) {
  if (editingPoints) stopEditingPoints(false); // switching tracks discards unsaved point edits
  activeTrackId = id;
  renderTrackList();
  refreshProjectTracksSource();
  openTrackEditor(activeTrack());
  const t = activeTrack();
  if (t) fitMapToCoords(t.coords);
}

function openTrackEditor(track) {
  const wrap = document.getElementById('track-editor-wrap');
  wrap.style.display = (currentSession && track) ? 'block' : 'none';
  if (!currentSession || !track) return;
  document.getElementById('track-editor-name').value = track.name || '';
  document.getElementById('track-editor-source-badge').textContent = track.source;
  document.getElementById('track-simplify-slider').value = track.simplify_tolerance_m || 0;
  document.getElementById('track-simplify-val').textContent = `${track.simplify_tolerance_m || 0} m`;
  document.getElementById('track-simplify-reset').disabled = !track.raw_points;
  document.getElementById('track-mark-exported-btn').textContent = track.is_exported ? 'Unmark exported' : 'Mark exported';
  document.getElementById('track-edit-points-btn').textContent = 'Edit points';
  setTrackEditorMessage('');
}

function closeTrackEditor() {
  stopEditingPoints(false);
  activeTrackId = null;
  document.getElementById('track-editor-wrap').style.display = 'none';
  renderTrackList();
  refreshProjectTracksSource();
}

function setTrackEditorMessage(msg) { document.getElementById('track-editor-message').textContent = msg; }

async function saveTrackGeometry(track, coords, tolerance) {
  const { error } = await sb.from('tracks')
    .update({ geom: toEWKT(coords), simplify_tolerance_m: tolerance })
    .eq('id', track.id);
  if (error) { setTrackEditorMessage(`Error: ${error.message}`); return; }
  track.coords = coords;
  track.geojson = { type: 'LineString', coordinates: coords };
  track.simplify_tolerance_m = tolerance;
  document.getElementById('track-simplify-slider').value = tolerance;
  document.getElementById('track-simplify-val').textContent = `${tolerance} m`;
  clearEditLineSource();
  refreshProjectTracksSource();
  setTrackEditorMessage('Saved.');
}

// ---------------------------------------------------------------------------
// Point editing (drag/insert/delete vertices) — hand-rolled with draggable
// maplibregl.Markers rather than a drawing library, so there's no dependency
// whose compatibility with this MapLibre version needs verifying. Practical
// for the tens-of-points a track has after simplification, not meant for
// hundreds of raw GPS points — simplify first.
// ---------------------------------------------------------------------------
function clearEditMarkers() {
  editVertexMarkers.forEach(m => m.remove());
  editVertexMarkers = [];
}

function rebuildEditMarkers() {
  clearEditMarkers();
  editWorkingCoords.forEach((coord, i) => {
    const el = document.createElement('div');
    el.className = 'track-vertex-handle';
    const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(coord).addTo(map);
    marker.on('dragend', () => {
      const { lng, lat } = marker.getLngLat();
      editWorkingCoords[i] = [lng, lat];
      setEditLineSource(editWorkingCoords);
    });
    el.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      if (editWorkingCoords.length <= 2) return; // a line needs at least 2 points
      editWorkingCoords.splice(i, 1);
      rebuildEditMarkers();
    });
    editVertexMarkers.push(marker);
  });
  setEditLineSource(editWorkingCoords);
}

function startEditingPoints() {
  const track = activeTrack();
  if (!track) return;
  editingPoints = true;
  editWorkingCoords = track.coords.map(c => c.slice());
  document.getElementById('track-edit-points-btn').textContent = 'Save points';
  refreshProjectTracksSource();
  rebuildEditMarkers();
}

function stopEditingPoints(save) {
  if (!editingPoints) { clearEditMarkers(); return; }
  editingPoints = false;
  document.getElementById('track-edit-points-btn').textContent = 'Edit points';
  clearEditMarkers();
  clearEditLineSource();
  const track = activeTrack();
  if (save && track && editWorkingCoords.length >= 2) {
    saveTrackGeometry(track, editWorkingCoords, track.simplify_tolerance_m || 0);
  } else {
    refreshProjectTracksSource();
  }
}

// ---------------------------------------------------------------------------
// Manual trail drawing — click the map to add points, same preview line/vertex
// styling as point-editing above.
// ---------------------------------------------------------------------------
function startManualDraw() {
  if (!currentProject || !currentSession) return;
  manualDrawActive = true;
  manualDrawCoords = [];
  clearManualDrawMarkers();
  document.getElementById('track-manual-btn').textContent = 'Finish drawing';
  map.getCanvas().style.cursor = 'crosshair';
}

function clearManualDrawMarkers() {
  manualDrawMarkers.forEach(m => m.remove());
  manualDrawMarkers = [];
}

function addManualDrawPoint(lngLat) {
  manualDrawCoords.push([lngLat.lng, lngLat.lat]);
  const el = document.createElement('div');
  el.className = 'track-vertex-handle';
  manualDrawMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map));
  setEditLineSource(manualDrawCoords);
}

async function finishManualDraw() {
  manualDrawActive = false;
  map.getCanvas().style.cursor = '';
  document.getElementById('track-manual-btn').textContent = 'Draw manual track';
  clearEditLineSource();
  const coords = manualDrawCoords;
  clearManualDrawMarkers();
  if (coords.length < 2) return;

  const { data, error } = await sb.from('tracks').insert({
    project_id: currentProject.id, name: 'New manual track', source: 'manual', geom: toEWKT(coords),
  }).select('id,name,source,simplify_tolerance_m,is_exported,created_at').single();
  if (error) { alert(`Could not save track: ${error.message}`); return; }

  currentTracks.push({ ...data, raw_points: null, coords, geojson: { type: 'LineString', coordinates: coords } });
  renderTrackList();
  refreshProjectTracksSource();
  selectTrack(data.id);
}

// ---------------------------------------------------------------------------
// FIT import — parse, show an elevation-profile chunk picker, save a chunk as
// a new track. The panel stays open after each save so several chunks can be
// cut from the same ride without re-uploading.
// ---------------------------------------------------------------------------
function closeFitImport() {
  document.getElementById('fit-import-wrap').style.display = 'none';
  fitRecords = null;
  fitDraggingHandle = null;
  clearFitImportSources();
}

function drawFitProfile() {
  const canvas = document.getElementById('fit-profile-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = 8;
  ctx.clearRect(0, 0, w, h);
  if (!fitRecords || fitRecords.length < 2) return;

  const n = fitRecords.length;
  const xAt = i => pad + (i / (n - 1)) * (w - pad * 2);
  const eles = fitRecords.map(r => r.ele).filter(e => e != null);
  const minE = eles.length ? Math.min(...eles) : 0;
  const maxE = eles.length ? Math.max(...eles) : 1;
  const span = Math.max(1, maxE - minE);

  ctx.fillStyle = 'rgba(255, 225, 77, 0.15)';
  ctx.fillRect(xAt(fitChunkStart), 0, xAt(fitChunkEnd) - xAt(fitChunkStart), h);

  ctx.strokeStyle = '#5ba4cf';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  fitRecords.forEach((r, i) => {
    const x = xAt(i);
    const y = eles.length ? h - pad - ((r.ele ?? minE) - minE) / span * (h - pad * 2) : h / 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = '#ffe14d';
  ctx.lineWidth = 2;
  [fitChunkStart, fitChunkEnd].forEach(i => {
    ctx.beginPath();
    ctx.moveTo(xAt(i), 0);
    ctx.lineTo(xAt(i), h);
    ctx.stroke();
  });
}

function fitIndexFromClientX(clientX) {
  const canvas = document.getElementById('fit-profile-canvas');
  const rect = canvas.getBoundingClientRect();
  const pad = 8;
  const scaleX = canvas.width / rect.width; // canvas internal width vs. CSS (100%) width can differ
  const xCanvas = (clientX - rect.left) * scaleX;
  const frac = (xCanvas - pad) / (canvas.width - pad * 2);
  return Math.round(Math.max(0, Math.min(1, frac)) * (fitRecords.length - 1));
}

function moveFitHandle(i) {
  if (fitDraggingHandle === 'start') fitChunkStart = i; else fitChunkEnd = i;
  fitChunkStart = Math.max(0, Math.min(fitChunkStart, fitRecords.length - 2));
  fitChunkEnd = Math.max(fitChunkStart + 1, Math.min(fitChunkEnd, fitRecords.length - 1));
  drawFitProfile();
  updateFitChunkSource();
}

function initFitProfileDragHandlers() {
  const canvas = document.getElementById('fit-profile-canvas');
  canvas.addEventListener('mousedown', e => {
    if (!fitRecords) return;
    const i = fitIndexFromClientX(e.clientX);
    fitDraggingHandle = Math.abs(i - fitChunkStart) <= Math.abs(i - fitChunkEnd) ? 'start' : 'end';
    moveFitHandle(i);
  });
  document.addEventListener('mousemove', e => {
    if (!fitDraggingHandle) return;
    moveFitHandle(fitIndexFromClientX(e.clientX));
  });
  document.addEventListener('mouseup', () => { fitDraggingHandle = null; });
}

async function handleFitFileChosen(file) {
  const statusEl = document.getElementById('fit-import-status');
  statusEl.textContent = 'Parsing…';
  try {
    const buf = await file.arrayBuffer();
    fitRecords = parseFitFile(buf);
    statusEl.textContent = `Parsed ${fitRecords.length} GPS points.`;
    fitChunkStart = 0;
    fitChunkEnd = fitRecords.length - 1;
    document.getElementById('fit-import-profile-wrap').style.display = 'block';
    setFitImportFullSource();
    drawFitProfile();
    updateFitChunkSource();
    fitMapToCoords(fitRecords.map(r => [r.lng, r.lat]));
  } catch (err) {
    statusEl.textContent = `Could not parse this file: ${err.message}`;
    document.getElementById('fit-import-profile-wrap').style.display = 'none';
  }
}

async function addFitChunkAsTrack() {
  if (!fitRecords || !currentProject) return;
  const slice = fitRecords.slice(fitChunkStart, fitChunkEnd + 1);
  if (slice.length < 2) return;
  const nameInput = document.getElementById('fit-import-chunk-name');
  const name = nameInput.value.trim() || `Chunk ${new Date().toLocaleDateString()}`;
  const coords = slice.map(r => [r.lng, r.lat]);
  const statusEl = document.getElementById('fit-import-status');
  statusEl.textContent = 'Saving…';

  const { data, error } = await sb.from('tracks').insert({
    project_id: currentProject.id, name, source: 'fit_upload', geom: toEWKT(coords), raw_points: slice,
  }).select('id,name,source,simplify_tolerance_m,is_exported,created_at').single();
  if (error) { statusEl.textContent = `Error: ${error.message}`; return; }

  currentTracks.push({ ...data, raw_points: slice, coords, geojson: { type: 'LineString', coordinates: coords } });
  renderTrackList();
  refreshProjectTracksSource();
  nameInput.value = '';
  statusEl.textContent = `Saved "${name}" — pick another chunk, or close when done.`;
}

// ---------------------------------------------------------------------------
// GPX export — client-side only, for manual upload into JOSM/iD (see
// mtb-editor/CLAUDE.md: no direct OSM API write-back in this pass).
// ---------------------------------------------------------------------------
function trackToGPX(track) {
  const raw = track.raw_points || [];
  const pts = track.coords.map(([lng, lat]) => {
    // Best-effort elevation from the immutable raw import — geometry may have
    // fewer points than raw_points after simplify/editing, so match by nearest
    // raw point rather than by index. ~1e-8 in squared-degree space is roughly
    // an 11m snap radius at these latitudes.
    let ele = null, best = Infinity;
    for (const p of raw) {
      const d = (p.lng - lng) ** 2 + (p.lat - lat) ** 2;
      if (d < best) { best = d; ele = p.ele; }
    }
    const eleTag = (ele != null && best < 1e-8) ? `<ele>${ele.toFixed(1)}</ele>` : '';
    return `<trkpt lat="${lat}" lon="${lng}">${eleTag}</trkpt>`;
  }).join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="mtb-editor" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <trk>\n    <name>${escapeHtml(track.name || 'track')}</name>\n    <trkseg>\n      ${pts}\n    </trkseg>\n  </trk>\n</gpx>`;
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportTrackGPX(track) {
  downloadText(`${(track.name || 'track').replace(/[^a-z0-9_-]+/gi, '_')}.gpx`, trackToGPX(track), 'application/gpx+xml');
  const tags = [`highway=path`, `mtb=yes`, track.name ? `name=${track.name}` : null, `mtb:scale=`].filter(Boolean).join('\n');
  alert(`GPX downloaded. Suggested OSM tags for JOSM/iD (fill in mtb:scale yourself):\n\n${tags}`);
}

// ---------------------------------------------------------------------------
// Comments/photos — always read/write through the public RPCs (get_public_track_history
// works for anyone; add_track_comment is the only anonymous write path in the
// whole schema), so this code doesn't need separate logged-in/anonymous branches
// for viewing. Photo upload stays authenticated-only (see the migration).
//
// Every track has two kinds of thread, same convention as trails/trail_history:
// the whole-track thread (location_id null — opened via the editor's "Comments"
// button) and any number of point threads (a track_locations id — opened by
// clicking the track itself, an existing point marker, or a bulk-matched photo).
// get_public_track_history returns everything for a track in one call; which
// thread is showing is just a client-side filter on location_id, not a
// separate query, since a track's comment volume is small.
// ---------------------------------------------------------------------------
function openTrackComments(track, locationId = null) {
  commentsTrackId = track.id;
  commentsLocationId = locationId;
  document.getElementById('track-comments-title').textContent =
    (track.name || 'Track') + (locationId ? ' — this point' : '');
  document.getElementById('track-comment-name').style.display = currentSession ? 'none' : 'block';
  document.getElementById('track-comment-photo').style.display = currentSession ? 'block' : 'none';
  document.getElementById('track-comment-text').value = '';
  document.getElementById('track-comment-message').textContent = '';
  document.getElementById('track-comments-wrap').style.display = 'flex';
  refreshTrackComments();
}

// Resolves (snapping to an existing nearby point if there is one) the location
// a track click landed on, then opens that point's thread — the "clicking on
// the track to add a comment/photo there" flow.
async function openTrackCommentsAtPoint(track, lng, lat) {
  const { data: locId, error } = await sb.rpc('find_or_create_track_location', {
    p_track_id: track.id, p_lng: lng, p_lat: lat,
  });
  if (error) { alert(`Could not resolve a location: ${error.message}`); return; }
  ensureLocalLocation(locId, track.id, lng, lat);
  openTrackComments(track, locId);
}

function closeTrackComments() {
  document.getElementById('track-comments-wrap').style.display = 'none';
  commentsTrackId = null;
  commentsLocationId = null;
}

async function refreshTrackComments() {
  const list = document.getElementById('track-comments-list');
  const { data, error } = await sb.rpc('get_public_track_history', { p_track_id: commentsTrackId });
  if (error) { list.innerHTML = '<div class="history-empty">Could not load comments.</div>'; return; }
  // location_id null == the whole-track bucket; otherwise only this point's own entries.
  const rows = data.filter(row => (row.location_id || null) === commentsLocationId);
  if (!rows.length) { list.innerHTML = '<div class="history-empty">No comments yet.</div>'; return; }

  trackHistoryImagePaths.clear();
  const items = rows.map(row => {
    const when = new Date(row.created_at).toLocaleString();
    const who = row.author_name ? escapeHtml(row.author_name) : 'Project member';
    let body;
    if (row.entry_type === 'image') {
      trackHistoryImagePaths.set(row.id, row.value.path);
      const { data: pub } = sb.storage.from('track-images').getPublicUrl(row.value.path);
      body = `<img src="${pub.publicUrl}" class="history-thumb">`;
    } else {
      body = escapeHtml(row.value.text || '');
    }
    // Delete is authenticated-only (moderation by the trusted maintainer group,
    // same as trails) — an anonymous viewer never sees this button, including
    // on their own comment; there's no account to prove ownership with. Uses
    // its own class (not index.html's .history-delete, though it reuses that
    // rule's styling) and its own click listener below, so it can never be
    // caught by index.html's trail_history/trail-images delegated handler.
    const deleteHtml = currentSession
      ? `<button class="history-delete track-history-delete" data-track-entry-id="${row.id}" title="Delete this entry">✕</button>`
      : '';
    return `<li><strong>${who}</strong><br>${body}<br><small>${when}</small>${deleteHtml}</li>`;
  });
  list.innerHTML = `<ul class="history-list">${items.join('')}</ul>`;
}

async function submitTrackComment() {
  const textEl = document.getElementById('track-comment-text');
  const text = textEl.value.trim();
  if (!text || !commentsTrackId) return;
  const name = document.getElementById('track-comment-name').value.trim();
  const msg = document.getElementById('track-comment-message');
  msg.textContent = 'Saving…';
  const { error } = await sb.rpc('add_track_comment', {
    p_track_id: commentsTrackId, p_text: text, p_author_name: currentSession ? null : name,
    p_location_id: commentsLocationId,
  });
  if (error) { msg.textContent = `Error: ${error.message}`; return; }
  textEl.value = '';
  msg.textContent = '';
  await refreshTrackComments();
}

async function uploadTrackCommentPhoto(file) {
  const msg = document.getElementById('track-comment-message');
  msg.textContent = 'Uploading…';
  try {
    const path = `${commentsTrackId}/${crypto.randomUUID()}-${file.name}`;
    const { error: upErr } = await sb.storage.from('track-images').upload(path, file);
    if (upErr) throw upErr;
    const { error } = await sb.from('track_history').insert({
      track_id: commentsTrackId, entry_type: 'image', location_id: commentsLocationId,
      value: { path, content_type: file.type, size_bytes: file.size },
    });
    if (error) throw error;
    msg.textContent = '';
    await refreshTrackComments();
  } catch (err) {
    msg.textContent = `Error: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Bulk photo upload — match several photos to points along a FIT-imported
// track by comparing each photo's EXIF timestamp (findExifDateTimeOriginal,
// above) to the track's recorded GPS times (raw_points[].time). A manual track
// has no raw_points/time data, so every photo just attaches to the whole track
// with no matching attempted. BULK_PHOTO_MAX_DELTA_MS bounds how far a photo's
// timestamp is allowed to drift from the nearest recorded point before it's
// treated as unmatched rather than guessed — camera-clock/FIT timezone drift
// is corrected via the offset input, not by widening this.
// ---------------------------------------------------------------------------
const BULK_PHOTO_MAX_DELTA_MS = 2 * 3600 * 1000; // 2 hours
let bulkPhotoObjectUrls = [];

function openBulkPhotoUpload() {
  const track = activeTrack();
  if (!track) return;
  bulkPhotoTrackId = track.id;
  bulkPhotoMatches = [];
  document.getElementById('track-bulk-photos-file').value = '';
  document.getElementById('track-bulk-photos-offset').value = '0';
  document.getElementById('track-bulk-photos-offset-val').textContent = '0';
  document.getElementById('track-bulk-photos-preview').innerHTML = '';
  document.getElementById('track-bulk-photos-message').textContent = track.raw_points
    ? '' : 'This track has no recorded GPS times (not a .fit import) — photos will attach to the whole track.';
  document.getElementById('track-bulk-photos-upload').disabled = true;
  document.getElementById('track-bulk-photos-wrap').style.display = 'flex';
}

function closeBulkPhotoUpload() {
  document.getElementById('track-bulk-photos-wrap').style.display = 'none';
  bulkPhotoObjectUrls.forEach(u => URL.revokeObjectURL(u));
  bulkPhotoObjectUrls = [];
  bulkPhotoTrackId = null;
  bulkPhotoMatches = [];
}

async function matchBulkPhotos() {
  const files = [...document.getElementById('track-bulk-photos-file').files];
  const track = currentTracks.find(t => t.id === bulkPhotoTrackId);
  if (!files.length || !track) return;
  const offsetHours = parseFloat(document.getElementById('track-bulk-photos-offset').value) || 0;
  const msg = document.getElementById('track-bulk-photos-message');
  msg.textContent = 'Reading photo timestamps…';

  const rawPoints = track.raw_points || [];
  bulkPhotoMatches = await Promise.all(files.map(async file => {
    let point = null, deltaMs = null, exifTime = null;
    try {
      const buf = await file.arrayBuffer();
      const dtStr = findExifDateTimeOriginal(buf);
      if (dtStr) {
        exifTime = exifDateTimeToMs(dtStr, offsetHours);
        if (exifTime != null && rawPoints.length) {
          let best = null, bestDelta = Infinity;
          for (const p of rawPoints) {
            if (p.time == null) continue;
            const d = Math.abs(p.time - exifTime);
            if (d < bestDelta) { bestDelta = d; best = p; }
          }
          if (best && bestDelta <= BULK_PHOTO_MAX_DELTA_MS) { point = best; deltaMs = bestDelta; }
        }
      }
    } catch (err) {
      console.error('EXIF read failed for', file.name, err);
    }
    return { file, exifTime, point, deltaMs };
  }));

  const matchedCount = bulkPhotoMatches.filter(m => m.point).length;
  msg.textContent = `${matchedCount} of ${files.length} matched to a point; the rest will attach to the whole track.`;
  renderBulkPhotoPreview();
  document.getElementById('track-bulk-photos-upload').disabled = false;
}

function renderBulkPhotoPreview() {
  bulkPhotoObjectUrls.forEach(u => URL.revokeObjectURL(u));
  bulkPhotoObjectUrls = [];
  const wrap = document.getElementById('track-bulk-photos-preview');
  wrap.innerHTML = bulkPhotoMatches.map(m => {
    const url = URL.createObjectURL(m.file);
    bulkPhotoObjectUrls.push(url);
    const label = m.point
      ? `<span class="bulk-photo-match matched">matched, ${Math.round(m.deltaMs / 60000)} min from recorded time</span>`
      : m.exifTime != null
        ? `<span class="bulk-photo-match unmatched">no nearby recorded time — whole track</span>`
        : `<span class="bulk-photo-match unmatched">no EXIF time found — whole track</span>`;
    return `<div class="bulk-photo-item"><img src="${url}"><div class="bulk-photo-info">` +
      `<div class="bulk-photo-name">${escapeHtml(m.file.name)}</div>${label}</div></div>`;
  }).join('');
}

async function uploadMatchedBulkPhotos() {
  if (!bulkPhotoMatches.length || !bulkPhotoTrackId) return;
  const msg = document.getElementById('track-bulk-photos-message');
  const uploadBtn = document.getElementById('track-bulk-photos-upload');
  uploadBtn.disabled = true;
  let done = 0;
  for (const m of bulkPhotoMatches) {
    msg.textContent = `Uploading ${done + 1} of ${bulkPhotoMatches.length}…`;
    try {
      let locationId = null;
      if (m.point) {
        const { data: locId, error: locErr } = await sb.rpc('find_or_create_track_location', {
          p_track_id: bulkPhotoTrackId, p_lng: m.point.lng, p_lat: m.point.lat,
        });
        if (locErr) throw locErr;
        locationId = locId;
        ensureLocalLocation(locationId, bulkPhotoTrackId, m.point.lng, m.point.lat);
      }
      const path = `${bulkPhotoTrackId}/${crypto.randomUUID()}-${m.file.name}`;
      const { error: upErr } = await sb.storage.from('track-images').upload(path, m.file);
      if (upErr) throw upErr;
      const { error } = await sb.from('track_history').insert({
        track_id: bulkPhotoTrackId, entry_type: 'image', location_id: locationId,
        value: { path, content_type: m.file.type, size_bytes: m.file.size },
      });
      if (error) throw error;
      done++;
    } catch (err) {
      msg.textContent = `Error on "${m.file.name}": ${err.message} — stopped after ${done} upload(s).`;
      uploadBtn.disabled = false;
      return;
    }
  }
  msg.textContent = `Uploaded ${done} photo(s).`;
  bulkPhotoMatches = [];
  document.getElementById('track-bulk-photos-preview').innerHTML = '';
  if (commentsTrackId === bulkPhotoTrackId) await refreshTrackComments();
}

// ---------------------------------------------------------------------------
// View state in the share link — camera position + layer toggles, captured as
// a snapshot when "Copy share link" is clicked (not kept continuously synced
// to the address bar, which would mean a history.replaceState on every pan).
// Reads/writes the same controls index.html's own inline script owns
// (#bg-select, #toggle-osm-lines, etc.) purely via DOM id + a dispatched
// 'change' event, never by calling index.html's internal functions directly —
// keeps this file decoupled from that script's internals, consistent with
// treating map/sb/currentSession/escapeHtml/VIEWER_STYLE as the only actual
// shared surface (see the file header comment).
// ---------------------------------------------------------------------------
function currentViewParams() {
  const c = map.getCenter();
  return {
    lng: c.lng.toFixed(5), lat: c.lat.toFixed(5), z: map.getZoom().toFixed(2),
    b: map.getBearing().toFixed(0), p: map.getPitch().toFixed(0),
    bg: document.getElementById('bg-select').value,
    lines: document.getElementById('toggle-osm-lines').checked ? 1 : 0,
    areas: document.getElementById('toggle-osm-areas').checked ? 1 : 0,
    trail: document.getElementById('toggle-trail-view').checked ? 1 : 0,
    terrain: document.getElementById('toggle-3d').checked ? 1 : 0,
  };
}

function hasViewParams(params) {
  return params.has('lng') && params.has('lat') && params.has('z');
}

function applyViewParamsFromURL(params) {
  if (hasViewParams(params)) {
    map.jumpTo({
      center: [parseFloat(params.get('lng')), parseFloat(params.get('lat'))],
      zoom: parseFloat(params.get('z')),
      bearing: parseFloat(params.get('b') || '0'),
      pitch: parseFloat(params.get('p') || '0'),
    });
  }
  if (params.has('bg')) {
    const el = document.getElementById('bg-select');
    el.value = params.get('bg');
    el.dispatchEvent(new Event('change'));
  }
  const applyToggle = (param, id) => {
    if (!params.has(param)) return;
    const el = document.getElementById(id);
    el.checked = params.get(param) === '1';
    el.dispatchEvent(new Event('change'));
  };
  applyToggle('lines', 'toggle-osm-lines');
  applyToggle('areas', 'toggle-osm-areas');
  applyToggle('trail', 'toggle-trail-view');
  applyToggle('terrain', 'toggle-3d');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function handleAuthChange(session) {
  document.getElementById('project-new-row').style.display = session ? 'flex' : 'none';
  document.getElementById('projects-picker-hint').style.display = session ? 'none' : 'block';
  document.getElementById('track-owner-controls').style.display = (session && currentProject) ? 'block' : 'none';
  loadMyProjects();
}

function wireUI() {
  document.getElementById('project-select').addEventListener('change', e => {
    if (e.target.value) openProject(e.target.value);
  });

  document.getElementById('project-new-create').addEventListener('click', async () => {
    const nameInput = document.getElementById('project-new-name');
    const name = nameInput.value.trim();
    if (!name || !currentSession) return;
    const { data, error } = await sb.from('projects').insert({ name }).select('id').single();
    if (error) { alert(`Could not create project: ${error.message}`); return; }
    nameInput.value = '';
    await loadMyProjects();
    document.getElementById('project-select').value = data.id;
    await openProject(data.id);
  });

  document.getElementById('project-close').addEventListener('click', closeProject);

  document.getElementById('project-share-link').addEventListener('click', async () => {
    const url = new URL(location.href);
    Object.entries(currentViewParams()).forEach(([k, v]) => url.searchParams.set(k, v));
    try {
      await navigator.clipboard.writeText(url.toString());
      const btn = document.getElementById('project-share-link');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (_) {
      prompt('Copy this link:', url.toString());
    }
  });

  document.getElementById('track-import-btn').addEventListener('click', () => {
    document.getElementById('fit-import-wrap').style.display = 'flex';
    document.getElementById('fit-import-file').value = '';
    document.getElementById('fit-import-status').textContent = '';
    document.getElementById('fit-import-profile-wrap').style.display = 'none';
    fitRecords = null;
    clearFitImportSources();
  });
  document.getElementById('fit-import-close').addEventListener('click', closeFitImport);
  document.getElementById('fit-import-done').addEventListener('click', closeFitImport);
  document.getElementById('fit-import-file').addEventListener('change', () => {
    const file = document.getElementById('fit-import-file').files[0];
    if (file) handleFitFileChosen(file);
  });
  document.getElementById('fit-import-add-chunk').addEventListener('click', addFitChunkAsTrack);
  initFitProfileDragHandlers();

  document.getElementById('track-manual-btn').addEventListener('click', () => {
    if (manualDrawActive) finishManualDraw(); else startManualDraw();
  });

  document.getElementById('track-editor-name').addEventListener('change', async () => {
    const track = activeTrack();
    if (!track) return;
    const name = document.getElementById('track-editor-name').value.trim();
    const { error } = await sb.from('tracks').update({ name }).eq('id', track.id);
    if (error) { setTrackEditorMessage(`Error: ${error.message}`); return; }
    track.name = name;
    renderTrackList();
  });

  document.getElementById('track-simplify-slider').addEventListener('input', e => {
    const track = activeTrack();
    if (!track) return;
    const tol = parseFloat(e.target.value);
    document.getElementById('track-simplify-val').textContent = `${tol} m`;
    setEditLineSource(simplifyLngLat(track.coords, tol));
  });
  document.getElementById('track-simplify-apply').addEventListener('click', () => {
    const track = activeTrack();
    if (!track) return;
    const tol = parseFloat(document.getElementById('track-simplify-slider').value);
    saveTrackGeometry(track, simplifyLngLat(track.coords, tol), tol);
  });
  document.getElementById('track-simplify-reset').addEventListener('click', () => {
    const track = activeTrack();
    if (!track || !track.raw_points) return;
    saveTrackGeometry(track, track.raw_points.map(p => [p.lng, p.lat]), 0);
  });

  document.getElementById('track-edit-points-btn').addEventListener('click', () => {
    if (editingPoints) stopEditingPoints(true); else startEditingPoints();
  });

  document.getElementById('track-mark-exported-btn').addEventListener('click', async () => {
    const track = activeTrack();
    if (!track) return;
    const next = !track.is_exported;
    const { error } = await sb.from('tracks').update({ is_exported: next }).eq('id', track.id);
    if (error) { setTrackEditorMessage(`Error: ${error.message}`); return; }
    track.is_exported = next;
    document.getElementById('track-mark-exported-btn').textContent = next ? 'Unmark exported' : 'Mark exported';
    renderTrackList();
    refreshProjectTracksSource();
  });

  document.getElementById('track-export-gpx-btn').addEventListener('click', () => {
    const track = activeTrack();
    if (track) exportTrackGPX(track);
  });

  document.getElementById('track-delete-btn').addEventListener('click', async () => {
    const track = activeTrack();
    if (!track) return;
    if (!confirm(`Delete "${track.name || 'this track'}"? This cannot be undone.`)) return;
    const { error } = await sb.from('tracks').delete().eq('id', track.id);
    if (error) { alert(`Could not delete: ${error.message}`); return; }
    currentTracks = currentTracks.filter(t => t.id !== track.id);
    closeTrackEditor();
    refreshProjectTracksSource();
  });

  document.getElementById('track-editor-close').addEventListener('click', closeTrackEditor);

  document.getElementById('track-comments-btn').addEventListener('click', () => {
    const track = activeTrack();
    if (track) openTrackComments(track);
  });
  document.getElementById('track-comments-close').addEventListener('click', closeTrackComments);
  document.getElementById('track-comment-text').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey) return;
    e.preventDefault();
    submitTrackComment();
  });
  document.getElementById('track-comment-photo').addEventListener('change', () => {
    const input = document.getElementById('track-comment-photo');
    const file = input.files[0];
    input.value = '';
    if (file && currentSession) uploadTrackCommentPhoto(file);
  });

  // Delegated on the list container itself (not document) so this can never be
  // reached by index.html's own trail_history-scoped delegated delete handler,
  // and vice versa — see the .track-history-delete comment in refreshTrackComments.
  document.getElementById('track-comments-list').addEventListener('click', async e => {
    const delBtn = e.target.closest('.track-history-delete');
    if (!delBtn || !currentSession) return;
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    const entryId = delBtn.dataset.trackEntryId;
    try {
      const { error } = await sb.from('track_history').delete().eq('id', entryId);
      if (error) throw error;
    } catch (err) {
      alert(`Could not delete: ${err.message}`);
      return;
    }
    const path = trackHistoryImagePaths.get(entryId);
    if (path) {
      const { error: rmErr } = await sb.storage.from('track-images').remove([path]);
      if (rmErr) console.error('Could not remove storage object for deleted entry', rmErr);
    }
    await refreshTrackComments();
  });

  document.getElementById('track-bulk-photos-btn').addEventListener('click', openBulkPhotoUpload);
  document.getElementById('track-bulk-photos-close').addEventListener('click', closeBulkPhotoUpload);
  document.getElementById('track-bulk-photos-offset').addEventListener('input', e => {
    document.getElementById('track-bulk-photos-offset-val').textContent = e.target.value;
  });
  document.getElementById('track-bulk-photos-match').addEventListener('click', matchBulkPhotos);
  document.getElementById('track-bulk-photos-upload').addEventListener('click', uploadMatchedBulkPhotos);
}

function initTracksFeature() {
  registerMapLayers();
  wireUI();
  window.onTracksAuthChange = handleAuthChange;
  handleAuthChange(currentSession);

  const params = new URLSearchParams(location.search);
  const initialProjectId = params.get('project');
  const explicitView = hasViewParams(params);
  if (explicitView) applyViewParamsFromURL(params);
  // A saved view in the link wins over the project's own auto-fit-to-tracks —
  // otherwise opening a project link would always snap back to "fit everything",
  // discarding the camera position the link was specifically saved to preserve.
  if (initialProjectId) openProject(initialProjectId, { fitView: !explicitView });
}

if (map.loaded()) initTracksFeature(); else map.on('load', initTracksFeature);
