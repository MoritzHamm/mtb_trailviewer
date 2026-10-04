// ---------------------------------------------------------------------------
// Projects — recordings, tracks, and project-level comments/photos. Kept out
// of index.html's already-~2400-line inline script since it's a largely
// self-contained feature. Loaded last (see index.html) so `map`/`sb`/
// `currentSession`/`escapeHtml`/`VIEWER_STYLE` already exist as globals — no
// module system, matches this project's no-build-step convention.
//
// A project has three modes (see mtb-editor/CLAUDE.md for the full writeup):
//   recordings — upload .fit/.gpx, bulk-import photos matched by timestamp,
//                extract tracks by picking a start/end on the elevation profile
//   tracks     — edit a track's geometry: move/insert/remove points, range
//                selection (remove / simplify / split), undo/redo, save
//   review     — read-mostly map of tracks + point comments/photos; the only
//                mode share-link visitors (no account) ever see
//
// Schema: supabase/migrations/0008_recordings_tracks_points.sql. Display reads
// go through the get_public_* security-definer RPCs (identical logged in or
// not); authenticated-only mutations use direct table calls. Recordings are
// authenticated-only and never exposed to share-link visitors.
// ---------------------------------------------------------------------------

let currentProject = null;       // { id, name, description, created_at } | null
let currentMode = 'review';      // 'recordings' | 'tracks' | 'review'

let currentRecordings = [];      // [{ id, name, file_name, format, point_count, started_at, ended_at, created_at, points?, cum? }]
let recordingsLoadedFor = null;  // project id the recordings list was loaded for (they're auth-only)
let activeRecordingId = null;
let recPickStart = 0;            // inclusive index range into the active recording's points
let recPickEnd = 0;
let recDraggingHandle = null;    // 'start' | 'end' | null
let recHoverIdx = null;          // profile hover position, mirrored as a dot on the map

let currentTracks = [];          // [{ id, name, source, coords, raw_points, vertex_origin, recording_id, ... }]
let activeTrackId = null;

let currentPoints = [];          // [{ id, geojson, label }] — project-level comment/photo locations
let projectHistory = [];         // every project_history row for the open project

let hiddenOsmWayIds = new Set(); // way-level osm_id's hidden from the base OSM layers
                                  // (every osm_way-sourced track's source_osm_way_ids, unioned)

// Tracks-mode edit session for the active track — null when not editing.
// coords/origin are replaced (never mutated per-coordinate) so undo snapshots
// can be cheap shallow copies.
let edit = null;  // { trackId, coords, origin, selStart, selEnd, selAnchor, undo: [], redo: [] }
let vertexDrag = null;

let manualDrawActive = false;
let manualDrawCoords = [];

let thread = null;               // open comment thread: { pointId, trackId } (both null = whole project)
const historyImagePaths = new Map();   // entryId -> storage path, for cleanup on delete

let bulkPhotoMatches = [];       // [{ file, exifTime, point, deltaMs }] after "Match photos"
let bulkPhotoObjectUrls = [];

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
// GPX parser — same output shape as parseFitFile ([{ lat, lng, ele, time }]).
// GPX is plain XML so the browser's DOMParser does the heavy lifting. Reads
// track points (<trkpt>, all <trk>/<trkseg> concatenated in document order),
// falling back to route points (<rtept>) for route-only files (planned routes
// exported from e.g. Komoot have no recorded track). Matches on localName so
// it works regardless of GPX 1.0/1.1 namespace or prefixing. <ele>/<time> are
// optional per the spec — missing ones become null, same as a FIT record
// without altitude/timestamp.
// ---------------------------------------------------------------------------
function parseGpxFile(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('not valid XML — not a GPX file');
  if (doc.documentElement.localName !== 'gpx') throw new Error('missing <gpx> root element — not a GPX file');

  const byLocalName = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));
  const childText = (el, name) => {
    const c = Array.from(el.children).find(n => n.localName === name);
    return c ? c.textContent.trim() : null;
  };

  let pts = byLocalName(doc, 'trkpt');
  if (!pts.length) pts = byLocalName(doc, 'rtept');

  const records = [];
  for (const p of pts) {
    const lat = parseFloat(p.getAttribute('lat'));
    const lng = parseFloat(p.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const eleText = childText(p, 'ele');
    const ele = eleText != null && Number.isFinite(parseFloat(eleText)) ? parseFloat(eleText) : null;
    const timeText = childText(p, 'time');
    const time = timeText != null && !Number.isNaN(Date.parse(timeText)) ? Date.parse(timeText) : null;
    records.push({ lat, lng, ele, time });
  }
  if (!records.length) throw new Error('no track or route points found in this GPX file');
  return records;
}

// Dispatch on extension, falling back to sniffing the FIT signature (bytes 8–11)
// for files with an unhelpful name.
async function parseTrackFile(file) {
  const buf = await file.arrayBuffer();
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'gpx') return parseGpxFile(new TextDecoder().decode(buf));
  if (ext === 'fit') return parseFitFile(buf);
  const sig = buf.byteLength >= 12 ? String.fromCharCode(...new Uint8Array(buf, 8, 4)) : '';
  return sig === '.FIT' ? parseFitFile(buf) : parseGpxFile(new TextDecoder().decode(buf));
}

// ---------------------------------------------------------------------------
// Minimal JPEG EXIF DateTimeOriginal reader — for matching bulk-uploaded photos
// to a point on a recording by timestamp. Hand-rolled for the same
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

function distMeters(a, b) {
  const mpd = metersPerDegreeAt((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * mpd.mLng, (b[1] - a[1]) * mpd.mLat);
}

// A vertex may not move more than this far from its origin (see vertex_origin,
// 0008_recordings_tracks_points.sql) — there's no real use case for dragging a vertex
// further than that, and it guards against a mis-drag silently relocating a
// point across the map. Projects onto the clamp boundary rather than rejecting
// the move outright, so a big drag still moves the vertex as far as it's
// allowed to.
const VERTEX_MOVE_CLAMP_M = 300;

function clampToOrigin(coord, origin) {
  if (!origin) return coord;
  const d = distMeters(origin, coord);
  if (d <= VERTEX_MOVE_CLAMP_M) return coord;
  const t = VERTEX_MOVE_CLAMP_M / d;
  return [origin[0] + (coord[0] - origin[0]) * t, origin[1] + (coord[1] - origin[1]) * t];
}

// Nearest-vertex snap candidate within the current project — the active track's
// own other vertices, plus every other track's vertices. Screen-space-agnostic
// (metres), fine at the zoom levels this editor is used at.
const SNAP_RADIUS_M = 12;

function findSnapCandidate(coord, excludeTrackId, excludeIndex) {
  let best = null, bestDist = SNAP_RADIUS_M;
  const consider = (pt) => {
    const d = distMeters(coord, pt);
    if (d < bestDist) { bestDist = d; best = pt; }
  };
  (edit ? edit.coords : []).forEach((pt, i) => { if (i !== excludeIndex) consider(pt); });
  currentTracks.forEach(t => {
    if (t.id === excludeTrackId) return;
    (t.coords || []).forEach(consider);
  });
  return best;
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

// Same as simplifyLngLat, but also subsets vertex_origin by the same kept
// indices (RDP only ever keeps exact original points, so this stays index-
// aligned with the returned coords) — used wherever a simplify result gets
// persisted, so the move-clamp baseline survives point-count changes.
function simplifyLngLatWithOrigin(coords, origin, toleranceM) {
  const src = origin && origin.length === coords.length ? origin : coords;
  if (coords.length < 3 || toleranceM <= 0) return { coords: coords.slice(), origin: src.slice() };
  const mpd = metersPerDegreeAt(coords[0][1]);
  const meters = coords.map(c => [c[0] * mpd.mLng, c[1] * mpd.mLat]);
  const keep = new Set([0, coords.length - 1]);
  rdpKeepIndices(meters, 0, coords.length - 1, toleranceM, keep);
  const idx = [...keep].sort((a, b) => a - b);
  return { coords: idx.map(i => coords[i]), origin: idx.map(i => src[i]) };
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

// Metres from a point to a polyline (flat local projection, same approximation
// as the rest of this file) — used to name which track a comment point is on.
function distToLineMeters(pt, coords) {
  if (!coords || !coords.length) return Infinity;
  const mpd = metersPerDegreeAt(pt[1]);
  const toM = c => [c[0] * mpd.mLng, c[1] * mpd.mLat];
  const p = toM(pt);
  if (coords.length === 1) return Math.hypot(p[0] - toM(coords[0])[0], p[1] - toM(coords[0])[1]);
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    best = Math.min(best, pointToSegmentDistSq(p, toM(coords[i]), toM(coords[i + 1])));
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// Map sources/layers
// ---------------------------------------------------------------------------
function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
function lineFeature(coords, props) { return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props || {} }; }
function fc(features) { return { type: 'FeatureCollection', features }; }
function setSourceData(id, data) { const s = map.getSource(id); if (s) s.setData(data); }

function hitBox(point, px) {
  return [[point.x - px, point.y - px], [point.x + px, point.y + px]];
}
function hitLayers(point, layers, px = 6) {
  const present = layers.filter(id => map.getLayer(id));
  return present.length ? map.queryRenderedFeatures(hitBox(point, px), { layers: present }) : [];
}

function registerMapLayers() {
  const T = VIEWER_STYLE.tracks;
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };

  map.addSource('project-tracks', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'project-tracks-line', type: 'line', source: 'project-tracks', layout: lineLayout,
    paint: {
      // Exported tracks are green; otherwise manual sketches get their own color
      // and everything else (recording/osm_way) is 'proposed' — see VIEWER_STYLE.tracks.
      'line-color': ['case', ['get', 'is_exported'], T.exported.color,
        ['match', ['get', 'source'], 'manual', T.manual.color, T.proposed.color]],
      'line-width': ['case', ['get', 'active'], 5, 3],
      'line-opacity': ['case', ['get', 'dim'], 0.45, 0.9],
      'line-dasharray': [2, 1],
    },
  });

  // Recordings mode: the whole active recording (faint) + the picked stretch.
  map.addSource('recording-full', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'recording-full-line', type: 'line', source: 'recording-full', layout: lineLayout,
    paint: {
      'line-color': T.rawImport.color, 'line-width': T.rawImport.width,
      'line-opacity': T.rawImport.opacity, 'line-dasharray': T.rawImport.dasharray,
    },
  });
  map.addSource('recording-pick', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'recording-pick-line', type: 'line', source: 'recording-pick', layout: lineLayout,
    paint: { 'line-color': T.chunkPick.color, 'line-width': T.chunkPick.width, 'line-opacity': T.chunkPick.opacity },
  });

  // Comment/photo points (only those that actually have entries).
  map.addSource('project-points', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'project-points-layer', type: 'circle', source: 'project-points',
    paint: {
      'circle-radius': T.locationPoint.radius,
      'circle-color': T.locationPoint.color,
      'circle-stroke-color': T.locationPoint.strokeColor,
      'circle-stroke-width': T.locationPoint.strokeWidth,
    },
  });

  // Tracks mode: the working line, the selected stretch, and every vertex. Vertices
  // are a circle layer (not one DOM marker each) so a raw, unsimplified track with
  // thousands of points stays responsive.
  map.addSource('track-edit-line', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'track-edit-line-layer', type: 'line', source: 'track-edit-line', layout: lineLayout,
    paint: { 'line-color': T.editLine.color, 'line-width': T.editLine.width, 'line-opacity': T.editLine.opacity },
  });
  map.addSource('track-edit-selection', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'track-edit-selection-layer', type: 'line', source: 'track-edit-selection', layout: lineLayout,
    paint: { 'line-color': T.vertexSelected.color, 'line-width': T.editLine.width + 3, 'line-opacity': 0.85 },
  });
  map.addSource('track-edit-vertices', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'track-edit-vertices-layer', type: 'circle', source: 'track-edit-vertices',
    paint: {
      'circle-radius': ['case', ['get', 'sel'], T.vertexSelected.radius, T.vertex.radius],
      'circle-color': ['case', ['get', 'sel'], T.vertexSelected.color, T.vertex.color],
      'circle-stroke-color': T.vertex.strokeColor,
      'circle-stroke-width': T.vertex.strokeWidth,
    },
  });

  // Profile-hover position on the active recording.
  map.addSource('recording-cursor', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'recording-cursor-layer', type: 'circle', source: 'recording-cursor',
    paint: { 'circle-radius': 6, 'circle-color': T.chunkPick.color, 'circle-stroke-color': '#1a1a1a', 'circle-stroke-width': 2 },
  });

  map.on('click', onMapClick);
  map.on('mousedown', 'track-edit-vertices-layer', onVertexMouseDown);
  map.on('mousemove', onMapHover);
}

// Cursor feedback — one handler instead of per-layer enter/leave pairs, since
// what's clickable depends on the mode.
function onMapHover(e) {
  if (!currentProject || vertexDrag) return;
  const canvas = map.getCanvas();
  if (manualDrawActive || (currentMode === 'recordings' && activeRecordingId)) { canvas.style.cursor = 'crosshair'; return; }
  if (currentMode === 'tracks' && edit && hitLayers(e.point, ['track-edit-vertices-layer'], 3).length) { canvas.style.cursor = 'move'; return; }
  if (currentMode === 'tracks' && edit && hitLayers(e.point, ['track-edit-line-layer']).length) { canvas.style.cursor = 'copy'; return; }
  if (hitLayers(e.point, ['project-tracks-line', 'project-points-layer']).length) { canvas.style.cursor = 'pointer'; return; }
  if (canvas.style.cursor === 'crosshair' || canvas.style.cursor === 'move' || canvas.style.cursor === 'copy') canvas.style.cursor = '';
}

// Single click dispatcher for everything this file handles on the map.
function onMapClick(e) {
  if (!currentProject) return;
  if (manualDrawActive) { addManualDrawPoint(e.lngLat); return; }

  if (currentMode === 'tracks') {
    if (edit) {
      // Vertex clicks are handled by the mousedown/mouseup drag logic.
      if (hitLayers(e.point, ['track-edit-vertices-layer'], 3).length) return;
      if (hitLayers(e.point, ['track-edit-line-layer']).length) { insertVertexAt([e.lngLat.lng, e.lngLat.lat]); return; }
    }
    const t = hitLayers(e.point, ['project-tracks-line'])[0];
    if (t) { selectTrack(t.properties.id); return; }
    if (edit) clearSelection();
    return;
  }

  if (currentMode === 'recordings') {
    if (activeRecordingId) moveNearestHandleToClick(e);
    return;
  }

  // review
  const p = hitLayers(e.point, ['project-points-layer'])[0];
  if (p) { openThread({ pointId: p.properties.id }); return; }
  if (hitLayers(e.point, ['project-tracks-line']).length) openThreadAtClick(e.lngLat);
}

// index.html's OSM-feature click handler asks this first, so a click meant for
// a project track/point/editor doesn't also open an OSM popup underneath.
window.tracksWantsMapClick = function (e) {
  if (!currentProject) return false;
  if (manualDrawActive) return true;
  if (currentMode === 'tracks' && edit) return true;
  if (currentMode === 'recordings' && activeRecordingId) return true;
  return hitLayers(e.point, ['project-tracks-line', 'project-points-layer']).length > 0;
};

function refreshProjectTracksSource() {
  const features = currentTracks
    // The track being edited is drawn by the edit layers instead.
    .filter(t => !(edit && t.id === edit.trackId))
    .map(t => lineFeature(t.coords, {
      id: t.id, source: t.source, is_exported: !!t.is_exported,
      active: t.id === activeTrackId,
      // In recordings mode, tracks from other recordings fade into the background.
      dim: currentMode === 'recordings' && !!activeRecordingId && t.recording_id !== activeRecordingId,
    }));
  setSourceData('project-tracks', fc(features));
}

function entriesForPoint(pointId) { return projectHistory.filter(r => r.point_id === pointId); }

function refreshPointsSource() {
  // Hidden while editing geometry — they'd just be clutter between the vertices.
  const features = currentMode === 'tracks' ? [] : currentPoints
    .filter(p => entriesForPoint(p.id).length > 0)
    .map(p => ({ type: 'Feature', geometry: p.geojson, properties: { id: p.id } }));
  setSourceData('project-points', fc(features));
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
const TRACK_COLUMNS = 'id,name,source,recording_id,recording_start_idx,recording_end_idx,raw_points,'
  + 'vertex_origin,is_exported,source_osm_type,source_osm_id,source_osm_way_ids,created_at';

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
// link already carries an explicit saved view (see applyViewParamsFromURL).
// Wrapped in try/catch end-to-end so a failure anywhere is at least logged.
async function openProject(id, opts = {}) {
  if (!confirmDiscardEdits()) return;
  try {
    const { data: proj, error } = await sb.rpc('get_public_project', { p_id: id }).single();
    if (error || !proj) { console.error(error); alert('Could not load that project — check the link.'); return; }
    const [{ data: tracks, error: tErr }, { data: points, error: pErr }] = await Promise.all([
      sb.rpc('get_public_tracks', { p_project_id: id }),
      sb.rpc('get_public_project_points', { p_project_id: id }),
    ]);
    if (tErr) console.error(tErr);
    if (pErr) console.error(pErr);

    endEditSession();
    deselectRecording();
    currentProject = proj;
    currentTracks = (tracks || []).map(t => ({ ...t, coords: t.geojson.coordinates }));
    currentPoints = points || [];
    currentRecordings = [];
    recordingsLoadedFor = null;
    activeTrackId = null;
    await refreshHistory();
    if (currentSession) await loadRecordings();

    renderProjectActive();
    setMode(currentSession ? (currentTracks.length ? 'tracks' : 'recordings') : 'review', { force: true });
    refreshHiddenOsmIds();
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
  if (!confirmDiscardEdits()) return;
  endEditSession();
  if (manualDrawActive) cancelManualDraw();
  deselectRecording();
  closeThread();
  currentProject = null;
  currentTracks = [];
  currentPoints = [];
  currentRecordings = [];
  recordingsLoadedFor = null;
  projectHistory = [];
  activeTrackId = null;
  renderProjectActive();
  renderTrackLists();
  refreshProjectTracksSource();
  refreshPointsSource();
  refreshHiddenOsmIds();

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
  document.getElementById('project-mode-tabs').style.display = currentSession ? 'flex' : 'none';
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
function confirmDiscardEdits() {
  if (!edit || !isEditDirty()) return true;
  const t = currentTracks.find(x => x.id === edit.trackId);
  return confirm(`Discard unsaved changes to "${t?.name || 'this track'}"?`);
}

// Returns false if the switch was cancelled (unsaved edits kept).
function setMode(mode, { force = false } = {}) {
  if (!currentSession) mode = 'review';
  if (mode === currentMode && !force) return true;
  if (!force && !confirmDiscardEdits()) return false;

  endEditSession();
  if (manualDrawActive) cancelManualDraw();
  if (mode !== 'recordings') deselectRecording();
  currentMode = mode;

  document.querySelectorAll('#project-mode-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  ['recordings', 'tracks', 'review'].forEach(m => {
    document.getElementById(`mode-${m}`).style.display = m === mode ? 'block' : 'none';
  });

  if (mode === 'tracks' && activeTrack()) startEditSession(activeTrack());
  renderRecordingList();
  renderTrackLists();
  refreshProjectTracksSource();
  refreshPointsSource();
  return true;
}

// ---------------------------------------------------------------------------
// Recordings mode
// ---------------------------------------------------------------------------
const RECORDING_META_COLUMNS = 'id,name,file_name,format,point_count,started_at,ended_at,created_at';

function activeRecording() { return currentRecordings.find(r => r.id === activeRecordingId); }
function tracksFromRecording(recId) { return currentTracks.filter(t => t.recording_id === recId); }

async function loadRecordings() {
  if (!currentProject || !currentSession) return;
  const projectId = currentProject.id;
  const { data, error } = await sb.from('recordings').select(RECORDING_META_COLUMNS)
    .eq('project_id', projectId).order('created_at');
  if (error) { console.error(error); return; }
  if (currentProject?.id !== projectId) return;
  currentRecordings = data;
  recordingsLoadedFor = projectId;
  renderRecordingList();
}

// Cumulative distance along the recording — the profile's x axis is distance,
// not point index, so standing still for ten minutes doesn't eat a third of
// the profile's width.
function prepareRecording(rec) {
  if (rec.cum) return;
  const cum = new Float64Array(rec.points.length);
  for (let i = 1; i < rec.points.length; i++) {
    const a = rec.points[i - 1], b = rec.points[i];
    cum[i] = cum[i - 1] + distMeters([a.lng, a.lat], [b.lng, b.lat]);
  }
  rec.cum = cum;
}

function formatKm(m) { return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`; }
function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function renderRecordingList() {
  const ul = document.getElementById('recording-list');
  ul.innerHTML = '';
  if (!currentRecordings.length) {
    ul.innerHTML = '<li class="item-list-empty">No recordings yet — upload a .fit or .gpx.</li>';
    return;
  }
  for (const r of currentRecordings) {
    const li = document.createElement('li');
    li.className = r.id === activeRecordingId ? 'active' : '';
    const when = r.started_at ? new Date(r.started_at).toLocaleDateString() : r.format.toUpperCase();
    const n = tracksFromRecording(r.id).length;
    li.innerHTML = `<span class="item-name">${escapeHtml(r.name)}<small>${escapeHtml(when)} · ${r.point_count} pts</small></span>`
      + `<span class="track-badge neutral">${n} track${n === 1 ? '' : 's'}</span>`;
    li.addEventListener('click', () => {
      if (r.id === activeRecordingId) deselectRecording(); else selectRecording(r.id);
    });
    ul.appendChild(li);
  }
}

async function uploadRecordings(files) {
  if (!currentProject || !currentSession || !files.length) return;
  const status = document.getElementById('recording-upload-status');
  let lastId = null;
  const errors = [];
  for (const [k, file] of files.entries()) {
    status.textContent = `Reading ${file.name} (${k + 1}/${files.length})…`;
    try {
      const points = await parseTrackFile(file);
      const times = points.map(p => p.time).filter(t => t != null);
      const format = /\.gpx$/i.test(file.name) ? 'gpx' : 'fit';
      const { data, error } = await sb.from('recordings').insert({
        project_id: currentProject.id,
        name: file.name.replace(/\.(fit|gpx)$/i, ''),
        file_name: file.name, format, points, point_count: points.length,
        started_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
        ended_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
      }).select(RECORDING_META_COLUMNS).single();
      if (error) throw error;
      currentRecordings.push({ ...data, points });
      lastId = data.id;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  status.textContent = errors.length ? `Could not import — ${errors.join('; ')}` : '';
  renderRecordingList();
  if (lastId) selectRecording(lastId);
}

async function selectRecording(id) {
  const rec = currentRecordings.find(r => r.id === id);
  if (!rec) return;
  activeRecordingId = id;
  renderRecordingList();
  const msg = document.getElementById('recording-message');
  if (!rec.points) {
    msg.textContent = 'Loading points…';
    const { data, error } = await sb.from('recordings').select('points').eq('id', id).single();
    if (activeRecordingId !== id) return; // user clicked something else meanwhile
    if (error) { msg.textContent = `Error: ${error.message}`; return; }
    rec.points = data.points;
  }
  msg.textContent = '';
  prepareRecording(rec);

  // Start the pick where the last extracted track from this recording ended, so
  // walking through a recording piece by piece needs no handle-dragging at all.
  const n = rec.points.length;
  const lastEnd = Math.max(-1, ...tracksFromRecording(id).map(t => t.recording_end_idx ?? -1));
  recPickStart = lastEnd > 0 && lastEnd < n - 2 ? lastEnd : 0;
  recPickEnd = n - 1;
  recHoverIdx = null;

  document.getElementById('recording-detail').style.display = 'block';
  document.getElementById('recording-name').value = rec.name;
  const timed = rec.points.some(p => p.time != null);
  document.getElementById('recording-meta').textContent =
    `${rec.file_name || rec.format.toUpperCase()} · ${formatKm(rec.cum[n - 1])}`
    + (rec.started_at && rec.ended_at ? ` · ${formatDuration(new Date(rec.ended_at) - new Date(rec.started_at))}` : '')
    + (timed ? '' : ' · no timestamps');
  document.getElementById('recording-bulk-photos-btn').disabled = !timed;
  document.getElementById('recording-bulk-photos-btn').title = timed ? '' : 'This recording has no timestamps to match photos against';
  document.getElementById('recording-dock').style.display = 'block';

  setSourceData('recording-full', fc([lineFeature(rec.points.map(p => [p.lng, p.lat]))]));
  refreshProjectTracksSource();
  updateRecordingPick();
  fitMapToCoords(rec.points.map(p => [p.lng, p.lat]));
}

function deselectRecording() {
  activeRecordingId = null;
  recDraggingHandle = null;
  recHoverIdx = null;
  document.getElementById('recording-detail').style.display = 'none';
  document.getElementById('recording-dock').style.display = 'none';
  ['recording-full', 'recording-pick', 'recording-cursor'].forEach(id => setSourceData(id, emptyFC()));
  renderRecordingList();
  refreshProjectTracksSource();
}

function updateRecordingPick() {
  const rec = activeRecording();
  if (!rec?.points) return;
  setSourceData('recording-pick', fc([lineFeature(rec.points.slice(recPickStart, recPickEnd + 1).map(p => [p.lng, p.lat]))]));
  drawRecordingProfile();

  const a = rec.points[recPickStart], b = rec.points[recPickEnd];
  const parts = [formatKm(rec.cum[recPickEnd] - rec.cum[recPickStart]), `${recPickEnd - recPickStart + 1} pts`];
  if (a.time != null && b.time != null) parts.push(formatDuration(b.time - a.time));
  document.getElementById('recording-dock-info').textContent = `Selected: ${parts.join(' · ')}`;
}

const PROFILE_PAD = 8;

function drawRecordingProfile() {
  const rec = activeRecording();
  const canvas = document.getElementById('recording-profile-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!rec?.points || rec.points.length < 2) return;

  const pts = rec.points, n = pts.length, total = rec.cum[n - 1] || 1, pad = PROFILE_PAD;
  const xAt = i => pad + (rec.cum[i] / total) * (w - pad * 2);
  const eles = pts.map(p => p.ele).filter(e => e != null);
  const minE = eles.length ? Math.min(...eles) : 0;
  const maxE = eles.length ? Math.max(...eles) : 1;
  const span = Math.max(1, maxE - minE);
  const yAt = i => eles.length ? h - pad - ((pts[i].ele ?? minE) - minE) / span * (h - pad * 2) : h / 2;

  // Already-extracted stretches.
  ctx.fillStyle = hexToRgba(VIEWER_STYLE.tracks.proposed.color, 0.22);
  for (const t of tracksFromRecording(rec.id)) {
    if (t.recording_start_idx == null || t.recording_end_idx == null) continue;
    const s = Math.max(0, t.recording_start_idx), e = Math.min(n - 1, t.recording_end_idx);
    ctx.fillRect(xAt(s), 0, Math.max(1, xAt(e) - xAt(s)), h);
  }

  // Current pick.
  ctx.fillStyle = hexToRgba(VIEWER_STYLE.tracks.chunkPick.color, 0.15);
  ctx.fillRect(xAt(recPickStart), 0, xAt(recPickEnd) - xAt(recPickStart), h);

  ctx.strokeStyle = '#5ba4cf';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) { if (i === 0) ctx.moveTo(xAt(i), yAt(i)); else ctx.lineTo(xAt(i), yAt(i)); }
  ctx.stroke();

  ctx.fillStyle = '#888';
  ctx.font = '10px system-ui, sans-serif';
  if (eles.length) {
    ctx.fillText(`${Math.round(maxE)} m`, pad + 2, pad + 8);
    ctx.fillText(`${Math.round(minE)} m`, pad + 2, h - pad - 2);
  }
  ctx.fillText(formatKm(total), w - pad - 40, h - pad - 2);

  ctx.strokeStyle = VIEWER_STYLE.tracks.chunkPick.color;
  ctx.lineWidth = 2;
  for (const i of [recPickStart, recPickEnd]) {
    ctx.beginPath(); ctx.moveTo(xAt(i), 0); ctx.lineTo(xAt(i), h); ctx.stroke();
  }

  if (recHoverIdx != null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xAt(recHoverIdx), 0); ctx.lineTo(xAt(recHoverIdx), h); ctx.stroke();
  }
}

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '');
  const v = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

// Profile x (CSS px, relative to the canvas) -> nearest point index, via
// binary search on cumulative distance.
function recIndexFromClientX(clientX) {
  const rec = activeRecording();
  const canvas = document.getElementById('recording-profile-canvas');
  const rect = canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - rect.left - PROFILE_PAD) / (rect.width - PROFILE_PAD * 2)));
  const n = rec.points.length;
  const target = frac * rec.cum[n - 1];
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rec.cum[mid] < target) lo = mid + 1; else hi = mid; }
  if (lo > 0 && target - rec.cum[lo - 1] < rec.cum[lo] - target) lo--;
  return lo;
}

function setRecHandle(which, i) {
  const n = activeRecording().points.length;
  if (which === 'start') recPickStart = Math.max(0, Math.min(i, recPickEnd - 1));
  else recPickEnd = Math.min(n - 1, Math.max(i, recPickStart + 1));
  updateRecordingPick();
}

function nearerHandle(i) {
  return Math.abs(i - recPickStart) <= Math.abs(i - recPickEnd) ? 'start' : 'end';
}

function setRecCursor(i) {
  const rec = activeRecording();
  recHoverIdx = i;
  setSourceData('recording-cursor', i == null || !rec?.points ? emptyFC()
    : fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [rec.points[i].lng, rec.points[i].lat] }, properties: {} }]));
}

function initRecordingProfileHandlers() {
  const canvas = document.getElementById('recording-profile-canvas');
  canvas.addEventListener('mousedown', e => {
    if (!activeRecording()?.points) return;
    e.preventDefault();
    const i = recIndexFromClientX(e.clientX);
    recDraggingHandle = nearerHandle(i);
    setRecHandle(recDraggingHandle, i);
  });
  canvas.addEventListener('mousemove', e => {
    if (!activeRecording()?.points || recDraggingHandle) return;
    setRecCursor(recIndexFromClientX(e.clientX));
    drawRecordingProfile();
  });
  canvas.addEventListener('mouseleave', () => {
    if (recDraggingHandle) return;
    setRecCursor(null);
    drawRecordingProfile();
  });
  document.addEventListener('mousemove', e => {
    if (!recDraggingHandle || !activeRecording()?.points) return;
    const i = recIndexFromClientX(e.clientX);
    setRecCursor(i);
    setRecHandle(recDraggingHandle, i);
  });
  document.addEventListener('mouseup', () => { recDraggingHandle = null; });
  window.addEventListener('resize', () => { if (activeRecordingId) drawRecordingProfile(); });
}

// Map click in recordings mode: snap to the nearest recording point (in screen
// space, so it behaves the same at every zoom) and move whichever handle is
// closer along the recording to it.
function moveNearestHandleToClick(e) {
  const rec = activeRecording();
  if (!rec?.points) return;
  let best = -1, bestD = 25 * 25; // px²
  for (let i = 0; i < rec.points.length; i++) {
    const p = map.project([rec.points[i].lng, rec.points[i].lat]);
    const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return;
  setRecHandle(nearerHandle(best), best);
}

async function extractTrackFromPick() {
  const rec = activeRecording();
  if (!rec?.points || !currentProject) return;
  const a = recPickStart, b = recPickEnd;
  const slice = rec.points.slice(a, b + 1);
  if (slice.length < 2) return;
  const nameInput = document.getElementById('extract-name');
  const name = nameInput.value.trim() || `${rec.name} – ${tracksFromRecording(rec.id).length + 1}`;
  const coords = slice.map(p => [p.lng, p.lat]);
  const msg = document.getElementById('recording-message');
  msg.textContent = 'Saving…';

  const { data, error } = await sb.from('tracks').insert({
    project_id: currentProject.id, name, source: 'recording', geom: toEWKT(coords),
    recording_id: rec.id, recording_start_idx: a, recording_end_idx: b,
    raw_points: slice, vertex_origin: coords,
  }).select(TRACK_COLUMNS).single();
  if (error) { msg.textContent = `Error: ${error.message}`; return; }

  currentTracks.push({ ...data, coords });
  nameInput.value = '';
  // Continue from where this one ended.
  if (b < rec.points.length - 2) { recPickStart = b; recPickEnd = rec.points.length - 1; }
  renderRecordingList();
  renderTrackLists();
  refreshProjectTracksSource();
  updateRecordingPick();
  msg.textContent = `Extracted "${name}" — pick the next stretch, or switch to Tracks to edit it.`;
}

async function renameRecording() {
  const rec = activeRecording();
  const name = document.getElementById('recording-name').value.trim();
  if (!rec || !name || name === rec.name) return;
  const { error } = await sb.from('recordings').update({ name }).eq('id', rec.id);
  if (error) { document.getElementById('recording-message').textContent = `Error: ${error.message}`; return; }
  rec.name = name;
  renderRecordingList();
}

async function deleteRecording() {
  const rec = activeRecording();
  if (!rec) return;
  const n = tracksFromRecording(rec.id).length;
  if (!confirm(`Delete recording "${rec.name}"?` + (n ? ` The ${n} track(s) extracted from it are kept.` : ''))) return;
  const { error } = await sb.from('recordings').delete().eq('id', rec.id);
  if (error) { alert(`Could not delete: ${error.message}`); return; }
  currentRecordings = currentRecordings.filter(r => r.id !== rec.id);
  currentTracks.forEach(t => { if (t.recording_id === rec.id) t.recording_id = null; });
  deselectRecording();
}

// ---------------------------------------------------------------------------
// Track lists (Tracks mode: pick one to edit; Review mode: fly to + comments)
// ---------------------------------------------------------------------------
function activeTrack() { return currentTracks.find(t => t.id === activeTrackId); }

function trackBadge(t) {
  const T = VIEWER_STYLE.tracks;
  if (t.is_exported) return { color: T.exported.color, label: 'exported' };
  if (t.source === 'manual') return { color: T.manual.color, label: 'manual' };
  if (t.source === 'osm_way') return { color: T.proposed.color, label: 'osm' };
  return { color: T.proposed.color, label: 'rec' };
}

function renderTrackLists() {
  const editUl = document.getElementById('track-list-edit');
  const reviewUl = document.getElementById('track-list-review');
  editUl.innerHTML = '';
  reviewUl.innerHTML = '';
  if (!currentTracks.length) {
    const empty = '<li class="item-list-empty">No tracks yet.</li>';
    editUl.innerHTML = empty;
    reviewUl.innerHTML = empty;
    return;
  }
  for (const t of currentTracks) {
    const b = trackBadge(t);
    const nameHtml = `<span class="item-name">${escapeHtml(t.name || '(untitled)')}</span>`;

    const li = document.createElement('li');
    li.className = t.id === activeTrackId ? 'active' : '';
    li.innerHTML = nameHtml + `<span class="track-badge" style="background:${b.color}">${b.label}</span>`;
    li.addEventListener('click', () => selectTrack(t.id));
    editUl.appendChild(li);

    const n = projectHistory.filter(r => r.track_id === t.id).length;
    const li2 = document.createElement('li');
    li2.className = t.id === activeTrackId ? 'active' : '';
    li2.innerHTML = nameHtml + `<button class="item-comments-btn" title="Comments on the whole track">💬 ${n}</button>`;
    li2.addEventListener('click', () => selectTrack(t.id));
    li2.querySelector('button').addEventListener('click', ev => {
      ev.stopPropagation();
      openThread({ trackId: t.id });
    });
    reviewUl.appendChild(li2);
  }
}

function selectTrack(id, { fit = true } = {}) {
  // Re-clicking the track already being edited must not restart (and so silently
  // discard) its edit session.
  if (id === activeTrackId && (edit?.trackId === id || currentMode !== 'tracks')) {
    const t = activeTrack();
    if (fit && t) fitMapToCoords(edit ? edit.coords : t.coords);
    return;
  }
  if (!confirmDiscardEdits()) return;
  if (manualDrawActive) cancelManualDraw();
  endEditSession();
  activeTrackId = id;
  const t = activeTrack();
  if (currentMode === 'tracks' && t && currentSession) startEditSession(t);
  renderTrackLists();
  refreshProjectTracksSource();
  if (fit && t) fitMapToCoords(t.coords);
}

function closeTrackEditor() {
  if (!confirmDiscardEdits()) return;
  endEditSession();
  activeTrackId = null;
  renderTrackLists();
  refreshProjectTracksSource();
}

// ---------------------------------------------------------------------------
// Tracks mode — edit session
// ---------------------------------------------------------------------------
// All geometry changes happen on edit.coords/edit.origin and are only written
// to the database on Save. Every change goes through commitEdit(before) with a
// snapshot taken beforehand, which is what undo restores — whole-array
// snapshots rather than per-op inverses, so range operations (remove a
// stretch, simplify part of a track) need no special undo logic.
//
// Selection is an inclusive vertex index range [selStart, selEnd]: click a
// vertex to select it, shift-click another to extend from the anchor.
// ---------------------------------------------------------------------------
function setEditorMessage(msg) { document.getElementById('track-editor-message').textContent = msg; }

function startEditSession(track) {
  const coords = track.coords.slice();
  const origin = track.vertex_origin && track.vertex_origin.length === coords.length
    ? track.vertex_origin.slice() : coords.slice();
  edit = { trackId: track.id, coords, origin, selStart: null, selEnd: null, selAnchor: null, undo: [], redo: [] };
  document.getElementById('track-editor-wrap').style.display = 'block';
  document.getElementById('track-editor-name').value = track.name || '';
  document.getElementById('track-editor-source-badge').textContent =
    track.source === 'recording' ? 'from recording' : track.source === 'osm_way' ? 'from OSM' : 'manual';
  document.getElementById('track-mark-exported-btn').textContent = track.is_exported ? 'Unmark exported' : 'Mark exported';
  document.getElementById('track-simplify-reset').disabled = !track.raw_points;
  resetSimplifySlider();
  setEditorMessage('');
  refreshProjectTracksSource();
  renderEdit();
}

function endEditSession() {
  if (!edit) return;
  edit = null;
  vertexDrag = null;
  document.getElementById('track-editor-wrap').style.display = 'none';
  ['track-edit-line', 'track-edit-selection', 'track-edit-vertices'].forEach(id => setSourceData(id, emptyFC()));
  refreshProjectTracksSource();
}

function isEditDirty() {
  if (!edit) return false;
  const t = currentTracks.find(x => x.id === edit.trackId);
  if (!t || t.coords.length !== edit.coords.length) return true;
  for (let i = 0; i < t.coords.length; i++) {
    if (t.coords[i][0] !== edit.coords[i][0] || t.coords[i][1] !== edit.coords[i][1]) return true;
  }
  return false;
}

function hasSelection() { return edit && edit.selStart != null; }

function snapshot() {
  return { coords: edit.coords.slice(), origin: edit.origin.slice(), selStart: edit.selStart, selEnd: edit.selEnd, selAnchor: edit.selAnchor };
}
function restore(s) {
  edit.coords = s.coords; edit.origin = s.origin;
  edit.selStart = s.selStart; edit.selEnd = s.selEnd; edit.selAnchor = s.selAnchor;
}

function commitEdit(before) {
  edit.undo.push(before);
  edit.redo = [];
  const n = edit.coords.length;
  if (hasSelection() && (edit.selEnd >= n || edit.selStart >= n)) clearSelection(true);
  resetSimplifySlider();
  renderEdit();
}

function undoEdit() {
  if (!edit || !edit.undo.length) return;
  edit.redo.push(snapshot());
  restore(edit.undo.pop());
  resetSimplifySlider();
  renderEdit();
}
function redoEdit() {
  if (!edit || !edit.redo.length) return;
  edit.undo.push(snapshot());
  restore(edit.redo.pop());
  resetSimplifySlider();
  renderEdit();
}

function clearSelection(silent) {
  if (!edit) return;
  edit.selStart = edit.selEnd = edit.selAnchor = null;
  if (!silent) { resetSimplifySlider(); renderEdit(); }
}

// previewCoords: draw these instead of edit.coords (simplify slider preview).
function renderEdit(previewCoords) {
  if (!edit) return;
  const coords = previewCoords || edit.coords;
  setSourceData('track-edit-line', coords.length >= 2 ? fc([lineFeature(coords)]) : emptyFC());
  const sel = !previewCoords && hasSelection();
  setSourceData('track-edit-vertices', fc(coords.map((c, i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: c },
    properties: { i, sel: sel && i >= edit.selStart && i <= edit.selEnd },
  }))));
  setSourceData('track-edit-selection', sel && edit.selEnd > edit.selStart
    ? fc([lineFeature(edit.coords.slice(edit.selStart, edit.selEnd + 1))]) : emptyFC());
  if (!previewCoords) updateEditorUI();
}

function pathLengthMeters(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += distMeters(coords[i - 1], coords[i]);
  return m;
}

function updateEditorUI() {
  if (!edit) return;
  const n = edit.coords.length;
  document.getElementById('track-undo-btn').disabled = !edit.undo.length;
  document.getElementById('track-redo-btn').disabled = !edit.redo.length;
  const dirty = isEditDirty();
  document.getElementById('track-save-btn').disabled = !dirty;
  document.getElementById('track-discard-btn').disabled = !dirty;
  document.getElementById('track-point-count').textContent = `${n} points · ${formatKm(pathLengthMeters(edit.coords))}`;

  const info = document.getElementById('track-selection-info');
  const sel = hasSelection();
  if (!sel) {
    info.textContent = 'Nothing selected — click a point, shift-click another to select the stretch between.';
  } else if (edit.selStart === edit.selEnd) {
    info.textContent = `Point ${edit.selStart + 1} of ${n} selected.`;
  } else {
    const len = pathLengthMeters(edit.coords.slice(edit.selStart, edit.selEnd + 1));
    info.textContent = `Points ${edit.selStart + 1}–${edit.selEnd + 1} selected (${formatKm(len)}).`;
  }
  document.getElementById('sel-remove-btn').disabled = !sel;
  document.getElementById('sel-split-btn').disabled = !sel || !splitCuts().length;
  document.getElementById('sel-clear-btn').disabled = !sel;
  document.getElementById('track-simplify-label').textContent =
    simplifyRange()[0] === 0 && simplifyRange()[1] === n - 1 ? 'Simplify whole track' : 'Simplify selection';
}

// --- vertex drag / click-to-select ---
function onVertexMouseDown(e) {
  if (!edit || currentMode !== 'tracks' || manualDrawActive) return;
  if (e.originalEvent.button !== 0) return;
  e.preventDefault(); // stops the map's drag-pan for this gesture
  const i = e.features[0].properties.i;
  vertexDrag = { i, startPt: e.point, moved: false, before: snapshot(), shift: e.originalEvent.shiftKey };
  map.on('mousemove', onVertexDragMove);
  // On window, not the map — a drag released outside the canvas must still end.
  window.addEventListener('mouseup', onVertexMouseUp, { once: true });
}

function onVertexDragMove(e) {
  const d = vertexDrag;
  if (!d || !edit) return;
  if (!d.moved && Math.hypot(e.point.x - d.startPt.x, e.point.y - d.startPt.y) < 3) return;
  d.moved = true;
  edit.coords[d.i] = [e.lngLat.lng, e.lngLat.lat];
  renderEdit();
}

function onVertexMouseUp(ev) {
  map.off('mousemove', onVertexDragMove);
  const d = vertexDrag;
  vertexDrag = null;
  if (!d || !edit) return;
  if (d.moved) {
    const rect = map.getCanvasContainer().getBoundingClientRect();
    const ll = map.unproject([ev.clientX - rect.left, ev.clientY - rect.top]);
    const raw = [ll.lng, ll.lat];
    const snapped = findSnapCandidate(raw, edit.trackId, d.i);
    edit.coords[d.i] = clampToOrigin(snapped || raw, edit.origin[d.i]);
    commitEdit(d.before);
  } else {
    if (d.shift && edit.selAnchor != null) {
      edit.selStart = Math.min(edit.selAnchor, d.i);
      edit.selEnd = Math.max(edit.selAnchor, d.i);
    } else if (edit.selStart === d.i && edit.selEnd === d.i) {
      clearSelection(true); // clicking the lone selected point again deselects it
    } else {
      edit.selAnchor = edit.selStart = edit.selEnd = d.i;
    }
    resetSimplifySlider();
    renderEdit();
  }
}

// --- operations ---
function insertVertexAt(pt) {
  const before = snapshot();
  const idx = nearestSegmentIndex(edit.coords, pt) + 1;
  edit.coords.splice(idx, 0, pt);
  edit.origin.splice(idx, 0, pt.slice()); // a new vertex's own creation point is its origin
  if (hasSelection()) {
    if (edit.selStart >= idx) edit.selStart++;
    if (edit.selEnd >= idx) edit.selEnd++;
    if (edit.selAnchor >= idx) edit.selAnchor++;
  }
  commitEdit(before);
}

// Removes the selected vertices; their neighbours get joined directly. A
// selection touching either end of the track trims that end.
function removeSelection() {
  if (!hasSelection()) return;
  const i = edit.selStart, j = edit.selEnd;
  if (edit.coords.length - (j - i + 1) < 2) { setEditorMessage('A track needs at least 2 points — can\'t remove that much.'); return; }
  const before = snapshot();
  edit.coords.splice(i, j - i + 1);
  edit.origin.splice(i, j - i + 1);
  clearSelection(true);
  setEditorMessage('');
  commitEdit(before);
}

// The stretch simplify applies to: the selection if it spans at least one
// interior point, otherwise the whole track.
function simplifyRange() {
  const n = edit.coords.length;
  if (hasSelection() && edit.selEnd - edit.selStart >= 2) return [edit.selStart, edit.selEnd];
  return [0, n - 1];
}

function simplifiedResult(tol) {
  const [i, j] = simplifyRange();
  const sub = simplifyLngLatWithOrigin(edit.coords.slice(i, j + 1), edit.origin.slice(i, j + 1), tol);
  return {
    coords: [...edit.coords.slice(0, i), ...sub.coords, ...edit.coords.slice(j + 1)],
    origin: [...edit.origin.slice(0, i), ...sub.origin, ...edit.origin.slice(j + 1)],
    i, newEnd: i + sub.coords.length - 1,
  };
}

function resetSimplifySlider() {
  document.getElementById('track-simplify-slider').value = 0;
  document.getElementById('track-simplify-val').textContent = '0 m';
  document.getElementById('track-simplify-apply').disabled = true;
}

function previewSimplify(tol) {
  if (!edit) return;
  document.getElementById('track-simplify-apply').disabled = tol <= 0;
  if (tol <= 0) { document.getElementById('track-simplify-val').textContent = '0 m'; renderEdit(); return; }
  const r = simplifiedResult(tol);
  document.getElementById('track-simplify-val').textContent = `${tol} m · ${edit.coords.length} → ${r.coords.length} pts`;
  renderEdit(r.coords);
}

function applySimplify() {
  if (!edit) return;
  const tol = parseFloat(document.getElementById('track-simplify-slider').value);
  if (!(tol > 0)) return;
  const before = snapshot();
  const r = simplifiedResult(tol);
  const wasRange = hasSelection() && edit.selEnd - edit.selStart >= 2;
  edit.coords = r.coords;
  edit.origin = r.origin;
  if (wasRange) { edit.selStart = r.i; edit.selEnd = r.newEnd; edit.selAnchor = r.i; }
  commitEdit(before);
}

function resetToRaw() {
  const track = currentTracks.find(t => t.id === edit?.trackId);
  if (!track?.raw_points) return;
  const before = snapshot();
  edit.coords = track.raw_points.map(p => [p.lng, p.lat]);
  edit.origin = edit.coords.slice();
  clearSelection(true);
  commitEdit(before);
}

async function saveEdit() {
  if (!edit) return;
  const track = currentTracks.find(t => t.id === edit.trackId);
  if (!track) return;
  const coords = edit.coords.slice(), origin = edit.origin.slice();
  setEditorMessage('Saving…');
  const { error } = await sb.from('tracks').update({ geom: toEWKT(coords), vertex_origin: origin }).eq('id', track.id);
  if (error) { setEditorMessage(`Error: ${error.message}`); return; }
  track.coords = coords;
  track.vertex_origin = origin;
  setEditorMessage('Saved.');
  updateEditorUI();
}

function discardEdit() {
  const track = currentTracks.find(t => t.id === edit?.trackId);
  if (!track) return;
  if (!confirm('Discard all unsaved changes to this track?')) return;
  startEditSession(track);
}

// --- split ---
// Cut points: the selection's boundaries, minus any that are a track end.
// One selected point = split in two there; a stretch = up to three tracks
// (before / the stretch / after).
function splitCuts() {
  if (!hasSelection()) return [];
  const n = edit.coords.length;
  return [...new Set([edit.selStart, edit.selEnd])].filter(k => k > 0 && k < n - 1).sort((a, b) => a - b);
}

// The raw_points/recording range that corresponds to a piece of a split track:
// nearest raw point to the piece's first vertex, then nearest after that to its
// last. Falls back to the parent's whole range if that doesn't come out ordered
// (e.g. an out-and-back where both ends sit on the same spot).
function rawFieldsForPiece(track, coords) {
  if (!track.raw_points?.length) return { raw_points: null };
  const raw = track.raw_points;
  const nearestFrom = (c, from) => {
    let best = from, bestD = Infinity;
    for (let k = from; k < raw.length; k++) {
      const d = (raw[k].lng - c[0]) ** 2 + (raw[k].lat - c[1]) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  };
  const a = nearestFrom(coords[0], 0);
  const b = nearestFrom(coords[coords.length - 1], a);
  if (b <= a) {
    return { raw_points: raw, recording_start_idx: track.recording_start_idx, recording_end_idx: track.recording_end_idx };
  }
  const base = track.recording_start_idx;
  return {
    raw_points: raw.slice(a, b + 1),
    recording_start_idx: base != null ? base + a : null,
    recording_end_idx: base != null ? base + b : null,
  };
}

async function splitAtSelection() {
  const track = currentTracks.find(t => t.id === edit?.trackId);
  const cuts = splitCuts();
  if (!track || !cuts.length) return;
  const bounds = [0, ...cuts, edit.coords.length - 1];
  const pieces = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    pieces.push({ coords: edit.coords.slice(bounds[k], bounds[k + 1] + 1), origin: edit.origin.slice(bounds[k], bounds[k + 1] + 1) });
  }
  if (!confirm(`Split "${track.name || 'this track'}" into ${pieces.length} tracks? `
    + 'This saves immediately, including any unsaved edits.')) return;

  const base = track.name || 'Track';
  // All against the parent's (still unsplit) raw_points, before anything mutates it.
  const raws = pieces.map(p => rawFieldsForPiece(track, p.coords));
  const first = pieces[0];
  const { error: updErr } = await sb.from('tracks')
    .update({ geom: toEWKT(first.coords), vertex_origin: first.origin, ...raws[0] })
    .eq('id', track.id);
  if (updErr) { setEditorMessage(`Could not split: ${updErr.message}`); return; }

  const rows = pieces.slice(1).map((p, k) => ({
    project_id: currentProject.id,
    name: `${base} (${k + 2})`,
    source: track.source,
    geom: toEWKT(p.coords),
    vertex_origin: p.origin,
    recording_id: track.recording_id,
    ...raws[k + 1],
    source_osm_type: track.source_osm_type,
    source_osm_id: track.source_osm_id,
    source_osm_way_ids: track.source_osm_way_ids || [],
  }));
  Object.assign(track, raws[0], { coords: first.coords, vertex_origin: first.origin });
  const { data, error } = await sb.from('tracks').insert(rows).select(TRACK_COLUMNS);
  if (error) { setEditorMessage(`First part saved, but creating the rest failed: ${error.message}`); return; }
  // Insert returns rows in insertion order; pair them back up with their coords.
  data.forEach((row, k) => currentTracks.push({ ...row, coords: pieces[k + 1].coords }));

  startEditSession(track);
  renderTrackLists();
  refreshProjectTracksSource();
  setEditorMessage(`Split into ${pieces.length} tracks.`);
}

// --- per-track metadata actions ---
async function renameActiveTrack() {
  const track = activeTrack();
  if (!track) return;
  const name = document.getElementById('track-editor-name').value.trim();
  const { error } = await sb.from('tracks').update({ name }).eq('id', track.id);
  if (error) { setEditorMessage(`Error: ${error.message}`); return; }
  track.name = name;
  renderTrackLists();
}

async function toggleExported() {
  const track = activeTrack();
  if (!track) return;
  const next = !track.is_exported;
  const { error } = await sb.from('tracks').update({ is_exported: next }).eq('id', track.id);
  if (error) { setEditorMessage(`Error: ${error.message}`); return; }
  track.is_exported = next;
  document.getElementById('track-mark-exported-btn').textContent = next ? 'Unmark exported' : 'Mark exported';
  renderTrackLists();
  refreshProjectTracksSource();
}

async function deleteActiveTrack() {
  const track = activeTrack();
  if (!track) return;
  if (!confirm(`Delete "${track.name || 'this track'}"? This cannot be undone.`)) return;
  const { error } = await sb.from('tracks').delete().eq('id', track.id);
  if (error) { alert(`Could not delete: ${error.message}`); return; }
  currentTracks = currentTracks.filter(t => t.id !== track.id);
  projectHistory = projectHistory.filter(r => r.track_id !== track.id); // cascaded server-side
  endEditSession();
  activeTrackId = null;
  renderTrackLists();
  refreshProjectTracksSource();
  refreshHiddenOsmIds();
}

// ---------------------------------------------------------------------------
// Manual drawing — click the map to add points; reuses the edit-line layer
// for the preview (no edit session is active while drawing).
// ---------------------------------------------------------------------------
function startManualDraw() {
  if (!currentProject || !currentSession) return;
  if (!confirmDiscardEdits()) return;
  endEditSession();
  activeTrackId = null;
  renderTrackLists();
  manualDrawActive = true;
  manualDrawCoords = [];
  document.getElementById('track-manual-btn').textContent = 'Finish drawing (Esc cancels)';
  renderManualDraw();
}

function renderManualDraw() {
  setSourceData('track-edit-line', manualDrawCoords.length >= 2 ? fc([lineFeature(manualDrawCoords)]) : emptyFC());
  setSourceData('track-edit-vertices', fc(manualDrawCoords.map((c, i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { i, sel: false },
  }))));
}

function addManualDrawPoint(lngLat) {
  manualDrawCoords.push([lngLat.lng, lngLat.lat]);
  renderManualDraw();
}

function cancelManualDraw() {
  manualDrawActive = false;
  manualDrawCoords = [];
  document.getElementById('track-manual-btn').textContent = 'Draw new track';
  ['track-edit-line', 'track-edit-vertices'].forEach(id => setSourceData(id, emptyFC()));
  map.getCanvas().style.cursor = '';
}

async function finishManualDraw() {
  const coords = manualDrawCoords;
  cancelManualDraw();
  if (coords.length < 2) return;
  const { data, error } = await sb.from('tracks').insert({
    project_id: currentProject.id, name: 'New track', source: 'manual',
    geom: toEWKT(coords), vertex_origin: coords,
  }).select(TRACK_COLUMNS).single();
  if (error) { alert(`Could not save track: ${error.message}`); return; }
  currentTracks.push({ ...data, coords });
  selectTrack(data.id, { fit: false });
}

// ---------------------------------------------------------------------------
// Copy from an existing OSM way/relation — called from index.html's trail
// popup, which collects/stitches the clipped vector-tile fragments (see
// stitchFragments there) and hands plain data across.
//
// wayIds is every fragment's own way-level osm_id (never a relation id, since
// line features don't carry one) — this becomes source_osm_way_ids, which
// drives which OSM ways get hidden from the base map while this copy exists.
// ---------------------------------------------------------------------------
window.addTrackFromOsmWay = async function (coords, identity, wayIds) {
  if (!currentProject || !currentSession) { alert('Open a project and log in first.'); return; }
  if (!coords || coords.length < 2) return;
  if (!confirmDiscardEdits()) return;

  const { data, error } = await sb.from('tracks').insert({
    project_id: currentProject.id,
    name: identity.osm_type === 'relation' ? 'Imported OSM route' : 'Imported OSM way',
    source: 'osm_way',
    geom: toEWKT(coords),
    vertex_origin: coords,
    source_osm_type: identity.osm_type,
    source_osm_id: identity.osm_id,
    source_osm_way_ids: wayIds || [],
  }).select(TRACK_COLUMNS).single();
  if (error) { alert(`Could not import trail: ${error.message}`); return; }

  currentTracks.push({ ...data, coords });
  refreshHiddenOsmIds();
  // Already confirmed above, so force — setMode then starts the edit session
  // on the new track since it's the active one.
  activeTrackId = data.id;
  setMode('tracks', { force: true });
};

// Every way-level osm_id belonging to an osm_way-sourced track in the open
// project is hidden from the base OSM line layers (index.html defines
// OSM_TRAIL_LINE_LAYERS) — otherwise the copied trail would render twice.
function refreshHiddenOsmIds() {
  hiddenOsmWayIds = new Set(
    currentTracks.filter(t => t.source === 'osm_way').flatMap(t => t.source_osm_way_ids || [])
  );
  applyHiddenOsmIdsFilter();
}

function applyHiddenOsmIdsFilter() {
  if (typeof OSM_TRAIL_LINE_LAYERS === 'undefined') return; // index.html not loaded yet
  const expr = hiddenOsmWayIds.size
    ? ['!', ['in', ['get', 'osm_id'], ['literal', [...hiddenOsmWayIds]]]]
    : null;
  OSM_TRAIL_LINE_LAYERS.forEach(id => { if (map.getLayer(id)) map.setFilter(id, expr); });
}
window.applyHiddenOsmIdsFilter = applyHiddenOsmIdsFilter;

// ---------------------------------------------------------------------------
// Comments/photos — project-level threads. A thread is a point (point_id), a
// whole track (track_id), or the project as a whole (neither). Reads go
// through get_public_project_history (everything for the project in one call;
// the open thread is a client-side filter), writes through add_project_comment
// — the only anonymous write path in the schema. Photo upload and entry
// deletion are authenticated-only.
// ---------------------------------------------------------------------------
async function refreshHistory() {
  if (!currentProject) return;
  const { data, error } = await sb.rpc('get_public_project_history', { p_project_id: currentProject.id });
  if (error) { console.error(error); return; }
  projectHistory = data || [];
  refreshPointsSource();
  renderTrackLists();
  const general = projectHistory.filter(r => !r.point_id && !r.track_id).length;
  document.getElementById('project-comments-btn').textContent = `Project comments (${general})`;
}

function ensureLocalPoint(id, lng, lat) {
  if (currentPoints.some(p => p.id === id)) return;
  currentPoints.push({ id, geojson: { type: 'Point', coordinates: [lng, lat] }, label: null });
}

function threadTitle() {
  if (thread.trackId) {
    return currentTracks.find(t => t.id === thread.trackId)?.name || 'Track';
  }
  if (thread.pointId) {
    const p = currentPoints.find(x => x.id === thread.pointId);
    if (!p) return 'Point';
    let best = null, bestD = 30; // only name a track the point is actually on
    for (const t of currentTracks) {
      const d = distToLineMeters(p.geojson.coordinates, t.coords);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? `${best.name || 'Track'} — this point` : 'This point';
  }
  return `${currentProject.name} — general`;
}

function openThread({ pointId = null, trackId = null } = {}) {
  thread = { pointId, trackId };
  document.getElementById('track-comments-title').textContent = threadTitle();
  document.getElementById('track-comment-name').style.display = currentSession ? 'none' : 'block';
  document.getElementById('track-comment-photo').style.display = currentSession ? 'block' : 'none';
  document.getElementById('track-comment-text').value = '';
  document.getElementById('track-comment-message').textContent = '';
  document.getElementById('track-comments-wrap').style.display = 'flex';
  renderThread();
}

// Click on a track in Review mode: resolve (snapping to an existing nearby
// point if there is one) and open that point's thread.
async function openThreadAtClick(lngLat) {
  const { data: pointId, error } = await sb.rpc('find_or_create_project_point', {
    p_project_id: currentProject.id, p_lng: lngLat.lng, p_lat: lngLat.lat,
  });
  if (error) { alert(`Could not resolve a location: ${error.message}`); return; }
  ensureLocalPoint(pointId, lngLat.lng, lngLat.lat);
  openThread({ pointId });
}

function closeThread() {
  document.getElementById('track-comments-wrap').style.display = 'none';
  thread = null;
}

function renderThread() {
  if (!thread) return;
  const list = document.getElementById('track-comments-list');
  const rows = projectHistory.filter(r =>
    (r.point_id || null) === thread.pointId && (r.track_id || null) === thread.trackId);
  if (!rows.length) { list.innerHTML = '<div class="history-empty">No comments yet.</div>'; return; }

  historyImagePaths.clear();
  const items = rows.map(row => {
    const when = new Date(row.created_at).toLocaleString();
    const who = row.author_name ? escapeHtml(row.author_name) : 'Project member';
    let body;
    if (row.entry_type === 'image') {
      historyImagePaths.set(row.id, row.value.path);
      const { data: pub } = sb.storage.from('track-images').getPublicUrl(row.value.path);
      body = `<img src="${pub.publicUrl}" class="history-thumb">`;
    } else {
      body = escapeHtml(row.value.text || '');
    }
    // Delete is authenticated-only (moderation by the trusted group). Own class
    // + listener so index.html's trail_history delete handler never catches it.
    const deleteHtml = currentSession
      ? `<button class="history-delete track-history-delete" data-entry-id="${row.id}" title="Delete this entry">✕</button>`
      : '';
    return `<li><strong>${who}</strong><br>${body}<br><small>${when}</small>${deleteHtml}</li>`;
  });
  list.innerHTML = `<ul class="history-list">${items.join('')}</ul>`;
}

async function submitComment() {
  const textEl = document.getElementById('track-comment-text');
  const text = textEl.value.trim();
  if (!text || !thread) return;
  const name = document.getElementById('track-comment-name').value.trim();
  const msg = document.getElementById('track-comment-message');
  msg.textContent = 'Saving…';
  const { error } = await sb.rpc('add_project_comment', {
    p_project_id: currentProject.id, p_text: text, p_author_name: currentSession ? null : name,
    p_point_id: thread.pointId, p_track_id: thread.trackId,
  });
  if (error) { msg.textContent = `Error: ${error.message}`; return; }
  textEl.value = '';
  msg.textContent = '';
  await refreshHistory();
  renderThread();
}

async function uploadImageEntry(file, pointId, trackId) {
  const path = `${currentProject.id}/${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await sb.storage.from('track-images').upload(path, file);
  if (upErr) throw upErr;
  const { error } = await sb.from('project_history').insert({
    project_id: currentProject.id, point_id: pointId, track_id: trackId, entry_type: 'image',
    value: { path, content_type: file.type, size_bytes: file.size },
  });
  if (error) throw error;
}

async function uploadThreadPhoto(file) {
  const msg = document.getElementById('track-comment-message');
  msg.textContent = 'Uploading…';
  try {
    await uploadImageEntry(file, thread.pointId, thread.trackId);
    msg.textContent = '';
    await refreshHistory();
    renderThread();
  } catch (err) {
    msg.textContent = `Error: ${err.message}`;
  }
}

async function deleteHistoryEntry(entryId) {
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  const { error } = await sb.from('project_history').delete().eq('id', entryId);
  if (error) { alert(`Could not delete: ${error.message}`); return; }
  const path = historyImagePaths.get(entryId);
  if (path) {
    const { error: rmErr } = await sb.storage.from('track-images').remove([path]);
    if (rmErr) console.error('Could not remove storage object for deleted entry', rmErr);
  }
  await refreshHistory();
  renderThread();
}

// ---------------------------------------------------------------------------
// Bulk photo import (Recordings mode) — match each photo's EXIF timestamp
// (findExifDateTimeOriginal) to the nearest recorded point time of the active
// recording, and place it as a project point there. Beyond
// BULK_PHOTO_MAX_DELTA_MS a photo counts as unmatched rather than guessed and
// goes to the project's general thread instead. Camera-clock/timezone drift is
// corrected via the offset input, not by widening the window.
// ---------------------------------------------------------------------------
const BULK_PHOTO_MAX_DELTA_MS = 2 * 3600 * 1000; // 2 hours

function openBulkPhotoUpload() {
  const rec = activeRecording();
  if (!rec?.points) return;
  bulkPhotoMatches = [];
  document.getElementById('bulk-photos-title').textContent = `Import photos — ${rec.name}`;
  document.getElementById('track-bulk-photos-file').value = '';
  document.getElementById('track-bulk-photos-offset').value = '0';
  document.getElementById('track-bulk-photos-offset-val').textContent = '0';
  document.getElementById('track-bulk-photos-preview').innerHTML = '';
  document.getElementById('track-bulk-photos-message').textContent = '';
  document.getElementById('track-bulk-photos-upload').disabled = true;
  document.getElementById('track-bulk-photos-wrap').style.display = 'flex';
}

function closeBulkPhotoUpload() {
  document.getElementById('track-bulk-photos-wrap').style.display = 'none';
  bulkPhotoObjectUrls.forEach(u => URL.revokeObjectURL(u));
  bulkPhotoObjectUrls = [];
  bulkPhotoMatches = [];
}

async function matchBulkPhotos() {
  const files = [...document.getElementById('track-bulk-photos-file').files];
  const rec = activeRecording();
  if (!files.length || !rec?.points) return;
  const offsetHours = parseFloat(document.getElementById('track-bulk-photos-offset').value) || 0;
  const msg = document.getElementById('track-bulk-photos-message');
  msg.textContent = 'Reading photo timestamps…';

  const timed = rec.points.filter(p => p.time != null);
  bulkPhotoMatches = await Promise.all(files.map(async file => {
    let point = null, deltaMs = null, exifTime = null;
    try {
      const dtStr = findExifDateTimeOriginal(await file.arrayBuffer());
      if (dtStr) {
        exifTime = exifDateTimeToMs(dtStr, offsetHours);
        if (exifTime != null) {
          let best = null, bestDelta = Infinity;
          for (const p of timed) {
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
  msg.textContent = `${matchedCount} of ${files.length} matched to a point; the rest go to the project's general comments.`;
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
        ? `<span class="bulk-photo-match unmatched">no nearby recorded time — general comments</span>`
        : `<span class="bulk-photo-match unmatched">no EXIF time found — general comments</span>`;
    return `<div class="bulk-photo-item"><img src="${url}"><div class="bulk-photo-info">` +
      `<div class="bulk-photo-name">${escapeHtml(m.file.name)}</div>${label}</div></div>`;
  }).join('');
}

async function uploadMatchedBulkPhotos() {
  if (!bulkPhotoMatches.length || !currentProject) return;
  const msg = document.getElementById('track-bulk-photos-message');
  const uploadBtn = document.getElementById('track-bulk-photos-upload');
  uploadBtn.disabled = true;
  let done = 0;
  for (const m of bulkPhotoMatches) {
    msg.textContent = `Uploading ${done + 1} of ${bulkPhotoMatches.length}…`;
    try {
      let pointId = null;
      if (m.point) {
        const { data, error } = await sb.rpc('find_or_create_project_point', {
          p_project_id: currentProject.id, p_lng: m.point.lng, p_lat: m.point.lat,
        });
        if (error) throw error;
        pointId = data;
        ensureLocalPoint(pointId, m.point.lng, m.point.lat);
      }
      await uploadImageEntry(m.file, pointId, null);
      done++;
    } catch (err) {
      msg.textContent = `Error on "${m.file.name}": ${err.message} — stopped after ${done} upload(s).`;
      // Drop the ones already uploaded so a retry doesn't duplicate them.
      bulkPhotoMatches = bulkPhotoMatches.slice(done);
      renderBulkPhotoPreview();
      uploadBtn.disabled = false;
      await refreshHistory();
      return;
    }
  }
  msg.textContent = `Uploaded ${done} photo(s).`;
  bulkPhotoMatches = [];
  document.getElementById('track-bulk-photos-preview').innerHTML = '';
  await refreshHistory();
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
// OSM export — same "generate exportable data, upload manually via JOSM" scope
// decision as trackToGPX/exportTrackGPX above, not a server round trip and not
// an attempt at action="modify"/version reconciliation against a real OSM way
// (this schema never fetches/stores a live version number, which JOSM needs to
// merge correctly) — always emits fresh negative-id nodes + one negative-id
// way, and when the segment came from OSM, tells the human reviewer the
// original id so they can cross-reference/merge manually in JOSM themselves.
// ---------------------------------------------------------------------------
function trackToOSMXML(track) {
  let nextId = -1;
  const nodeIds = track.coords.map(() => nextId--);
  const nodes = track.coords.map(([lng, lat], i) =>
    `  <node id="${nodeIds[i]}" lat="${lat}" lon="${lng}" version="1" />`).join('\n');
  const wayId = nextId;
  const refs = nodeIds.map(id => `    <nd ref="${id}" />`).join('\n');
  const tags = [
    ['highway', 'path'],
    ['mtb', 'yes'],
    track.name ? ['name', track.name] : null,
    ['mtb:scale', ''],
  ].filter(Boolean).map(([k, v]) => `    <tag k="${k}" v="${escapeHtml(v)}" />`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<osm version="0.6" generator="mtb-editor">\n${nodes}\n` +
    `  <way id="${wayId}" version="1">\n${refs}\n${tags}\n  </way>\n</osm>`;
}

function exportTrailSegmentOSM(track) {
  downloadText(`${(track.name || 'trail').replace(/[^a-z0-9_-]+/gi, '_')}.osm`, trackToOSMXML(track), 'application/xml');
  let msg = 'OSM XML downloaded — open it in JOSM (File > Open), review, then upload.';
  if (track.source_osm_type && track.source_osm_id != null) {
    msg += `\n\nThis segment started from an existing OSM ${track.source_osm_type} `
      + `(id ${track.source_osm_id}) — cross-reference/merge with it manually in JOSM, `
      + `this export does not attempt to diff against the live version.`;
  }
  alert(msg);
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
// Controls that no longer exist are skipped rather than crashing the share
// button (the OSM lines/areas checkboxes were replaced by the "Map layers"
// dropdown, which isn't captured here yet).
const VIEW_TOGGLES = { lines: 'toggle-osm-lines', areas: 'toggle-osm-areas', trail: 'toggle-trail-view', terrain: 'toggle-3d' };

function currentViewParams() {
  const c = map.getCenter();
  const params = {
    lng: c.lng.toFixed(5), lat: c.lat.toFixed(5), z: map.getZoom().toFixed(2),
    b: map.getBearing().toFixed(0), p: map.getPitch().toFixed(0),
  };
  const bg = document.getElementById('bg-select');
  if (bg) params.bg = bg.value;
  for (const [param, id] of Object.entries(VIEW_TOGGLES)) {
    const el = document.getElementById(id);
    if (el) params[param] = el.checked ? 1 : 0;
  }
  return params;
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
  const bg = document.getElementById('bg-select');
  if (params.has('bg') && bg) {
    bg.value = params.get('bg');
    bg.dispatchEvent(new Event('change'));
  }
  for (const [param, id] of Object.entries(VIEW_TOGGLES)) {
    const el = document.getElementById(id);
    if (!params.has(param) || !el) continue;
    el.checked = params.get(param) === '1';
    el.dispatchEvent(new Event('change'));
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function handleAuthChange(session) {
  document.getElementById('project-new-row').style.display = session ? 'flex' : 'none';
  document.getElementById('projects-picker-hint').style.display = session ? 'none' : 'block';
  loadMyProjects();
  if (!currentProject) return;
  renderProjectActive();
  if (!session) {
    currentRecordings = [];
    recordingsLoadedFor = null;
    setMode('review', { force: true });
  } else if (recordingsLoadedFor !== currentProject.id) {
    loadRecordings();
  }
}

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function onKeyDown(e) {
  if (!currentProject || isTypingTarget(e.target)) return;
  if (manualDrawActive) {
    if (e.key === 'Escape') { e.preventDefault(); cancelManualDraw(); }
    else if (e.key === 'Enter') { e.preventDefault(); finishManualDraw(); }
    return;
  }
  if (!edit || currentMode !== 'tracks') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redoEdit(); else undoEdit();
  } else if ((e.ctrlKey || e.metaKey) && k === 's') {
    e.preventDefault();
    if (isEditDirty()) saveEdit();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (hasSelection()) { e.preventDefault(); removeSelection(); }
  } else if (e.key === 'Escape') {
    if (hasSelection()) { e.preventDefault(); clearSelection(); }
  }
}

function wireUI() {
  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);

  on('project-select', 'change', e => { if (e.target.value) openProject(e.target.value); });
  on('project-new-create', 'click', async () => {
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
  on('project-close', 'click', closeProject);
  on('project-share-link', 'click', async () => {
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

  document.querySelectorAll('#project-mode-tabs button').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  // Recordings mode
  on('recording-upload', 'change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    uploadRecordings(files);
  });
  on('recording-name', 'change', renameRecording);
  on('extract-btn', 'click', extractTrackFromPick);
  on('recording-bulk-photos-btn', 'click', openBulkPhotoUpload);
  on('recording-delete-btn', 'click', deleteRecording);
  on('recording-dock-close', 'click', deselectRecording);
  initRecordingProfileHandlers();

  // Tracks mode
  on('track-manual-btn', 'click', () => { if (manualDrawActive) finishManualDraw(); else startManualDraw(); });
  on('track-editor-name', 'change', renameActiveTrack);
  on('sel-remove-btn', 'click', removeSelection);
  on('sel-split-btn', 'click', splitAtSelection);
  on('sel-clear-btn', 'click', () => clearSelection());
  on('track-simplify-slider', 'input', e => previewSimplify(parseFloat(e.target.value)));
  on('track-simplify-apply', 'click', applySimplify);
  on('track-simplify-reset', 'click', resetToRaw);
  on('track-undo-btn', 'click', undoEdit);
  on('track-redo-btn', 'click', redoEdit);
  on('track-save-btn', 'click', saveEdit);
  on('track-discard-btn', 'click', discardEdit);
  on('track-export-gpx-btn', 'click', () => { const t = activeTrack(); if (t) exportTrackGPX(edit ? { ...t, coords: edit.coords } : t); });
  on('track-export-osm-btn', 'click', () => { const t = activeTrack(); if (t) exportTrailSegmentOSM(edit ? { ...t, coords: edit.coords } : t); });
  on('track-mark-exported-btn', 'click', toggleExported);
  on('track-delete-btn', 'click', deleteActiveTrack);
  on('track-editor-close', 'click', closeTrackEditor);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', e => {
    if (isEditDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Review mode + comment threads
  on('project-comments-btn', 'click', () => openThread({}));
  on('track-comments-close', 'click', closeThread);
  on('track-comment-text', 'keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey) return;
    e.preventDefault();
    submitComment();
  });
  on('track-comment-photo', 'change', () => {
    const input = document.getElementById('track-comment-photo');
    const file = input.files[0];
    input.value = '';
    if (file && currentSession && thread) uploadThreadPhoto(file);
  });
  // Delegated on the list container (not document) so this never overlaps with
  // index.html's own trail_history delegated delete handler.
  on('track-comments-list', 'click', e => {
    const delBtn = e.target.closest('.track-history-delete');
    if (delBtn && currentSession) deleteHistoryEntry(delBtn.dataset.entryId);
  });

  // Bulk photo import
  on('track-bulk-photos-close', 'click', closeBulkPhotoUpload);
  on('track-bulk-photos-offset', 'input', e => {
    document.getElementById('track-bulk-photos-offset-val').textContent = e.target.value;
  });
  on('track-bulk-photos-match', 'click', matchBulkPhotos);
  on('track-bulk-photos-upload', 'click', uploadMatchedBulkPhotos);
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
  // A saved view in the link wins over the project's own auto-fit-to-tracks.
  if (initialProjectId) openProject(initialProjectId, { fitView: !explicitView });
}

// Start once the style is ready, not on map 'load' — 'load' waits for every
// source's first tiles, so a single source that never finishes (e.g. a local
// placeholder terrain.pmtiles with no real tiles) would leave the whole
// project panel unwired.
if (map.style && map.style._loaded) initTracksFeature(); else map.once('style.load', initTracksFeature);
