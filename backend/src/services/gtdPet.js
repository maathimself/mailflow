import { query } from './db.js';

// GTD Inbox-Zero pet: cache a user's OWN imported pet (an uploaded pet.json + spritesheet)
// and serve its animation descriptor and spritesheet bytes to the GtdZeroPet component,
// keyed by slug. Nothing is fetched from a remote host — the bytes always arrive in the
// import payload — so the defense is byte-level: size caps, magic-byte image sniffing, and
// a defensive pet.json parse.
//
// The pure pieces (slug derivation, image sniffing/sizing, and the defensive pet.json
// parse) are exported and unit-tested.

const JSON_CAP = 256 * 1024;
const SHEET_CAP = 5 * 1024 * 1024;
// A tiny file can still declare huge header dimensions (a WebP VP8X width/height is a
// 24-bit field, so a ~100-byte file can claim 16M px). readImageSize reads those header
// values, and the derived descriptor drives the frontend sprite layout — so cap the
// dimensions to keep an absurd sheet from producing a giant CSS background-size. A typical
// imported sheet is 1536×1872, comfortably inside this.
const MAX_SHEET_DIM = 8192;

// Normalise and validate a pet slug. Returns a lowercased slug or null. The read routes
// key meta/sheet lookups by :slug (a path param, always a bare slug) and the ownership
// gate compares it against customPetSlug, so this is pure slug hygiene. Pure.
export function parsePetSlug(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : null;
}

// Derive the storage slug for a user's own imported pet from their session user id.
// `custom-<userUuidHex>` is deterministic (re-import overwrites the same cache row),
// globally unique per user (never clobbers another user's pet), and already matches
// parsePetSlug's charset — so no regex, migration, or read-route change is needed. The
// slug is ALWAYS server-derived; the client never picks the storage key. Returns null if
// the id is missing or somehow not slug-safe. Pure.
export function customPetSlug(userId) {
  if (typeof userId !== 'string' || !userId) return null;
  const hex = userId.replace(/-/g, '').toLowerCase();
  if (!hex) return null; // guard the degenerate all-hyphen id → shared 'custom-' slug
  const slug = `custom-${hex}`;
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : null;
}

// Identify the image type from its magic bytes (no image library allowed). Returns
// an image mime or null. Pure.
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  // WebP: "RIFF"…"WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // GIF: "GIF87a" / "GIF89a"
  const gif = buf.toString('ascii', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return null;
}

// Read pixel dimensions straight from the header bytes for PNG, GIF, and all three
// WebP sub-formats (VP8X extended, VP8 lossy, VP8L lossless). Returns { width,
// height } or null. Pure — the frame-grid math depends on it, so it is unit-tested
// against the real steve-jobs sheet.
export function readImageSize(buf) {
  if (!buf || buf.length < 12) return null;
  const mime = sniffImageMime(buf);
  if (mime === 'image/png') {
    if (buf.length < 24) return null;
    // IHDR width/height are 32-bit big-endian at offset 16 / 20.
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === 'image/gif') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (mime === 'image/webp') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      // flags(1) reserved(3) width-1(3 LE) height-1(3 LE), payload at offset 20.
      if (buf.length < 30) return null;
      const width = buf.readUIntLE(24, 3) + 1;
      const height = buf.readUIntLE(27, 3) + 1;
      return { width, height };
    }
    if (fourcc === 'VP8 ') {
      // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit width/height LE.
      if (buf.length < 30) return null;
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (fourcc === 'VP8L') {
      // Lossless: 0x2f signature then 14-bit width-1 / 14-bit height-1 packed LE.
      if (buf.length < 25 || buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }
  return null;
}

// Decode an uploaded spritesheet from the import payload into raw bytes. Accepts a
// `data:<mime>;base64,<data>` URL (the declared mime is IGNORED — sniffImageMime
// decides the real type) or a bare base64 string. Returns a Buffer, or null when the
// input is not a usable string. Byte-level image validation is the caller's job
// (sniffImageMime), so this only handles the transport decode. Pure.
export function decodeUploadedSheet(input) {
  if (typeof input !== 'string') return null;
  let b64 = input.trim();
  if (!b64) return null;
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma < 0) return null;
    b64 = b64.slice(comma + 1).trim();
    if (!b64) return null;
  }
  const buf = Buffer.from(b64, 'base64');
  return buf.length ? buf : null;
}

function firstPositiveInt(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// Try to recognise an explicit hover animation in the (undocumented) pet.json.
// Accepts a handful of plausible shapes; returns { start, count } within the sheet,
// or null so the caller applies the "loop the first row" fallback.
function recognizeHoverSequence(j, cols, frameCount) {
  const anims = j?.animations || j?.sequences;
  if (!anims || typeof anims !== 'object') return null;
  const pick = (name) => (Array.isArray(anims) ? anims.find(a => a?.name === name) : anims[name]);
  const seq = pick('jump') || pick('hover') || pick('idle') || pick('wave');
  if (!seq) return null;
  // Shapes: [f0, f1, …]  |  { frames: [...] }  |  { start, count }  |  { row }
  const frames = Array.isArray(seq) ? seq : seq.frames;
  if (Array.isArray(frames) && frames.length) {
    const start = clampInt(frames[0], 0, frameCount - 1, 0);
    return { start, count: Math.min(frames.length, frameCount - start) };
  }
  const start = firstPositiveInt(seq.start) ?? (Number.isInteger(seq.start) ? seq.start : null);
  const count = firstPositiveInt(seq.count, seq.length);
  if (start != null && count) return { start: clampInt(start, 0, frameCount - 1, 0), count: Math.min(count, frameCount) };
  const row = firstPositiveInt(seq.row) ?? (Number.isInteger(seq.row) ? seq.row : null);
  if (row != null && cols) return { start: clampInt(row * cols, 0, frameCount - 1, 0), count: cols };
  return null;
}

// The 8×9 sprite convention packs one animation per row, each row padded with blank
// trailing cells (row 0 idle = 6 populated frames + 2 blank, row 4 jump = 5 + 3,
// …). pet.json names no sequences, so a hover loop of `cols` frames sweeps those
// blank cells and flashes. The celebratory jump — the ❤️ the description promises —
// lives on row 4 with 5 populated frames; loop exactly those so steps() stays on
// real art.
const CONVENTION_8X9_JUMP = { row: 4, frames: 5 };

// Hover sequence to use when pet.json declares none. For the 8×9 convention we know
// the layout, so loop its jump row over just the populated frames; for a declared
// grid we don't know the padding, so keep the plain first-row loop.
function fallbackHover(source, cols, frameCount) {
  if (source === 'convention-8x9') {
    const start = Math.min(CONVENTION_8X9_JUMP.row * cols, frameCount - 1);
    return { start, count: Math.min(CONVENTION_8X9_JUMP.frames, frameCount - start) };
  }
  return { start: 0, count: cols };
}

// Derive a frontend animation descriptor from pet.json + the sheet dimensions. A minimal
// pet.json carries NO animation schema (only id/displayName/description/spritesheetPath),
// so the common path is the 8×9 sprite-grid convention with a jump-row hover loop. Any
// recognisable explicit grid/sequence overrides it. Pure.
export function parsePetJson(petJson, imageSize) {
  const width = imageSize?.width;
  const height = imageSize?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const j = (petJson && typeof petJson === 'object') ? petJson : {};

  let cols = firstPositiveInt(j.cols, j.columns, j.frameCols, j.grid?.cols, j.grid?.columns);
  let rows = firstPositiveInt(j.rows, j.frameRows, j.grid?.rows);
  let frameW = firstPositiveInt(j.frameWidth, j.frameW, j.tileWidth, j.grid?.frameWidth);
  let frameH = firstPositiveInt(j.frameHeight, j.frameH, j.tileHeight, j.grid?.frameHeight);
  let source = 'declared';

  if (frameW && frameH) {
    cols = cols || Math.max(1, Math.round(width / frameW));
    rows = rows || Math.max(1, Math.round(height / frameH));
  } else if (cols && rows) {
    frameW = Math.floor(width / cols);
    frameH = Math.floor(height / rows);
  }

  if (!cols || !rows || !frameW || !frameH) {
    // Fallback: the 8×9 sprite grid, frame size derived from the sheet.
    cols = 8;
    rows = 9;
    frameW = Math.floor(width / cols);
    frameH = Math.floor(height / rows);
    source = 'convention-8x9';
  }

  if (frameW <= 0 || frameH <= 0) return null;
  const frameCount = cols * rows;
  const staticFrame = clampInt(j.staticFrame ?? j.restFrame ?? j.idleFrame, 0, frameCount - 1, 0);
  const hover = recognizeHoverSequence(j, cols, frameCount) || fallbackHover(source, cols, frameCount);

  return { cols, rows, frameW, frameH, frameCount, staticFrame, hover, source };
}

// Validate an in-memory spritesheet Buffer + parsed pet.json, derive the animation
// descriptor, and upsert the cache row. The image type is decided by MAGIC BYTES only,
// never a declared/HTTP content-type; the stored descriptor is DERIVED (raw pet.json is
// never persisted). Throws an Error with a `.code` on any validation failure.
async function finalizeAndStorePet({ slug, petJson, sheet, displayNameFallback }) {
  const mime = sniffImageMime(sheet);
  if (!mime) throw Object.assign(new Error('Spritesheet is not a recognised image'), { code: 'BAD_IMAGE' });
  const size = readImageSize(sheet);
  if (!size) throw Object.assign(new Error('Could not read spritesheet dimensions'), { code: 'BAD_IMAGE' });
  if (size.width > MAX_SHEET_DIM || size.height > MAX_SHEET_DIM) {
    throw Object.assign(new Error(`Spritesheet dimensions exceed ${MAX_SHEET_DIM}px`), { code: 'BAD_IMAGE' });
  }

  const descriptor = parsePetJson(petJson, size);
  if (!descriptor) throw Object.assign(new Error('Could not derive pet animation from the assets'), { code: 'BAD_META' });
  descriptor.width = size.width;
  descriptor.height = size.height;

  // petJson may not be an object even after a clean JSON.parse — the text "null" parses to
  // null, "true"/"42" to primitives — so coerce it the same way parsePetJson does before
  // reading a field. Dereferencing null here threw an UNCODED TypeError that surfaced as the
  // route's generic 500 instead of a coded/validated response; a null manifest now stores
  // like an empty one, falling back to the slug for the display name.
  const meta = (petJson && typeof petJson === 'object') ? petJson : {};
  const displayName = typeof meta.displayName === 'string' && meta.displayName.trim()
    ? meta.displayName.trim().slice(0, 120)
    : displayNameFallback;

  await query(
    `INSERT INTO gtd_pets (slug, display_name, descriptor, sheet_data, sheet_mime, is_custom, fetched_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
     ON CONFLICT (slug) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           descriptor   = EXCLUDED.descriptor,
           sheet_data   = EXCLUDED.sheet_data,
           sheet_mime   = EXCLUDED.sheet_mime,
           is_custom    = EXCLUDED.is_custom,
           fetched_at   = NOW()`,
    // is_custom is always true: importPet is the only writer, and imported pets
    // are private to their importer (the meta/sheet read gate keys off it).
    [slug, displayName, JSON.stringify(descriptor), sheet, mime, true]
  );

  return { slug, displayName, descriptor };
}

// Import a user's OWN pet from directly-supplied bytes: pet.json text + a spritesheet
// Buffer, uploaded through POST /pet/import. No URL is ever fetched — the bytes always
// arrive in the payload — so the whole defense is: the caps below, magic-byte sniffing +
// defensive parse inside finalizeAndStorePet, and the server-derived slug. Returns
// { slug, displayName, descriptor }; throws an Error with a `.code` on any failure.
export async function importPet({ petJsonText, sheet, userId }) {
  const slug = customPetSlug(userId);
  if (!slug) throw Object.assign(new Error('Could not derive a storage slug for this user'), { code: 'BAD_SLUG' });

  if (typeof petJsonText !== 'string') throw Object.assign(new Error('pet.json text is required'), { code: 'BAD_JSON' });
  if (Buffer.byteLength(petJsonText, 'utf8') > JSON_CAP) throw Object.assign(new Error('pet.json exceeds size cap'), { code: 'BAD_JSON' });
  let petJson;
  try { petJson = JSON.parse(petJsonText); } catch { throw Object.assign(new Error('pet.json is not valid JSON'), { code: 'BAD_JSON' }); }

  if (!Buffer.isBuffer(sheet) || !sheet.length) throw Object.assign(new Error('Spritesheet bytes are required'), { code: 'BAD_IMAGE' });
  if (sheet.length > SHEET_CAP) throw Object.assign(new Error('Spritesheet exceeds size cap'), { code: 'TOO_LARGE' });

  return finalizeAndStorePet({ slug, petJson, sheet, displayNameFallback: slug });
}

// Read a cached pet's metadata (descriptor) for the frontend. Returns null when the
// slug is invalid or not cached. `isCustom` feeds the read routes' ownership gate;
// the routes strip it before responding.
export async function getPetMeta(slug) {
  const s = parsePetSlug(slug);
  if (!s) return null;
  const { rows } = await query('SELECT slug, display_name, descriptor, is_custom FROM gtd_pets WHERE slug = $1', [s]);
  if (!rows.length) return null;
  return { slug: rows[0].slug, displayName: rows[0].display_name, descriptor: rows[0].descriptor, isCustom: rows[0].is_custom };
}

// Read a cached pet's spritesheet bytes + mime. Returns null when absent.
export async function getPetSheet(slug) {
  const s = parsePetSlug(slug);
  if (!s) return null;
  const { rows } = await query('SELECT sheet_data, sheet_mime, is_custom FROM gtd_pets WHERE slug = $1', [s]);
  if (!rows.length) return null;
  return { data: rows[0].sheet_data, mime: rows[0].sheet_mime, isCustom: rows[0].is_custom };
}
