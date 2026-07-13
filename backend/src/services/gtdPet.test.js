import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  parsePetSlug,
  sniffImageMime,
  readImageSize,
  parsePetJson,
  customPetSlug,
  decodeUploadedSheet,
  importPet,
} from './gtdPet.js';

// ── Image-header fixtures (crafted magic bytes, no image library) ──────────────

function webpVP8X(w, h) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x10; // alpha flag
  buf.writeUIntLE(w - 1, 24, 3);
  buf.writeUIntLE(h - 1, 27, 3);
  return buf;
}

function png(w, h) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function gif(w, h) {
  // A real GIF header is 13 bytes (6-byte signature + 7-byte logical screen
  // descriptor); dimensions live at offset 6/8.
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

// A minimal pet.json — deliberately no animation schema, so it drives the 8×9 convention.
const STEVE_JOBS_PET_JSON = {
  id: 'steve-jobs',
  displayName: 'Steve Jobs',
  description: 'A tiny pixel-art Steve Jobs companion in a black turtleneck, jeans, glasses, and sneakers.',
  spritesheetPath: 'spritesheet.webp',
};

describe('parsePetSlug', () => {
  it('accepts a bare slug and lowercases it', () => {
    expect(parsePetSlug('steve-jobs')).toBe('steve-jobs');
    expect(parsePetSlug('Steve-Jobs')).toBe('steve-jobs');
  });

  it('rejects URL-shaped input, bad shapes, and traversal', () => {
    expect(parsePetSlug('https://evil.com/pets/steve-jobs')).toBeNull();
    expect(parsePetSlug('../etc/passwd')).toBeNull();
    expect(parsePetSlug('has spaces')).toBeNull();
    expect(parsePetSlug('')).toBeNull();
    expect(parsePetSlug(null)).toBeNull();
  });
});

describe('sniffImageMime', () => {
  it('recognises webp, png, and gif magic bytes', () => {
    expect(sniffImageMime(webpVP8X(100, 100))).toBe('image/webp');
    expect(sniffImageMime(png(100, 100))).toBe('image/png');
    expect(sniffImageMime(gif(100, 100))).toBe('image/gif');
  });

  it('returns null for non-images', () => {
    expect(sniffImageMime(Buffer.from('<html>not an image</html>'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(4))).toBeNull();
  });
});

describe('readImageSize', () => {
  it('reads steve-jobs VP8X dimensions (1536×1872)', () => {
    expect(readImageSize(webpVP8X(1536, 1872))).toEqual({ width: 1536, height: 1872 });
  });

  it('returns null for a truncated VP8X header instead of throwing', () => {
    // A 16-29 byte RIFF/WEBP/VP8X prefix used to reach readUIntLE(24,3) and
    // throw a RangeError that leaked into the route's 400 body.
    for (const len of [16, 20, 24, 29]) {
      expect(readImageSize(webpVP8X(100, 100).subarray(0, len))).toBeNull();
    }
  });

  it('reads png and gif dimensions', () => {
    expect(readImageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageSize(gif(48, 24))).toEqual({ width: 48, height: 24 });
  });

  it('returns null for unrecognised bytes', () => {
    expect(readImageSize(Buffer.from('nope'))).toBeNull();
  });
});

describe('parsePetJson — defensive parse', () => {
  it('falls back to the 8×9 grid for steve-jobs (no animation schema)', () => {
    const d = parsePetJson(STEVE_JOBS_PET_JSON, { width: 1536, height: 1872 });
    expect(d).toMatchObject({
      cols: 8, rows: 9, frameW: 192, frameH: 208, frameCount: 72,
      staticFrame: 0, source: 'convention-8x9',
      // Hover loops the jump row (row 4) over its 5 populated frames, not row 0's
      // 8 columns — row 0 has 2 blank trailing cells that would flash on hover.
      hover: { start: 32, count: 5 },
    });
  });

  it('honours an explicit grid + hover sequence when present', () => {
    const d = parsePetJson(
      { cols: 4, rows: 2, staticFrame: 1, animations: { jump: { start: 4, count: 4 } } },
      { width: 400, height: 200 }
    );
    expect(d).toMatchObject({ cols: 4, rows: 2, frameW: 100, frameH: 100, staticFrame: 1, source: 'declared' });
    expect(d.hover).toEqual({ start: 4, count: 4 });
  });

  it('derives the grid from an explicit frame size', () => {
    const d = parsePetJson({ frameWidth: 64, frameHeight: 64 }, { width: 512, height: 256 });
    expect(d).toMatchObject({ cols: 8, rows: 4, frameW: 64, frameH: 64, source: 'declared' });
  });

  it('returns null when the sheet size is unusable', () => {
    expect(parsePetJson(STEVE_JOBS_PET_JSON, { width: 0, height: 0 })).toBeNull();
    expect(parsePetJson(STEVE_JOBS_PET_JSON, null)).toBeNull();
  });
});

// ── Custom pet import (user uploads pet.json + spritesheet directly) ────────────

describe('customPetSlug', () => {
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/; // the same guard parsePetSlug applies to read routes

  it('derives a deterministic, slug-safe key from a user UUID', () => {
    const id = '3F2A1B4C-5D6E-7F80-9A1B-2C3D4E5F6071';
    const slug = customPetSlug(id);
    expect(slug).toBe('custom-3f2a1b4c5d6e7f809a1b2c3d4e5f6071');
    expect(customPetSlug(id)).toBe(slug);         // deterministic — re-import overwrites
    expect(SLUG_RE.test(slug)).toBe(true);         // no regex change needed anywhere
    expect(slug.length).toBeLessThanOrEqual(64);
  });

  it('returns null for a missing or degenerate id (never the shared custom- slug)', () => {
    expect(customPetSlug(null)).toBeNull();
    expect(customPetSlug(undefined)).toBeNull();
    expect(customPetSlug('')).toBeNull();
    expect(customPetSlug('-')).toBeNull();  // all-hyphen id must not collapse to 'custom-'
    expect(customPetSlug(42)).toBeNull();
  });
});

describe('decodeUploadedSheet', () => {
  it('decodes a data: URL, ignoring the declared mime (magic bytes win)', () => {
    const bytes = webpVP8X(100, 100);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`; // deliberately wrong mime
    const out = decodeUploadedSheet(dataUrl);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(sniffImageMime(out)).toBe('image/webp'); // decided by content, not the data: label
  });

  it('decodes a bare base64 string round-trip', () => {
    const bytes = png(64, 64);
    const out = decodeUploadedSheet(bytes.toString('base64'));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(bytes)).toBe(true);
  });

  it('returns null for structurally unusable input', () => {
    expect(decodeUploadedSheet(null)).toBeNull();
    expect(decodeUploadedSheet('')).toBeNull();
    expect(decodeUploadedSheet('   ')).toBeNull();
    expect(decodeUploadedSheet('data:image/png')).toBeNull();          // no comma
    expect(decodeUploadedSheet('data:image/png;base64,')).toBeNull();  // empty payload
  });
});

describe('importPet', () => {
  const userId = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
  const DERIVED_SLUG = 'custom-3f2a1b4c5d6e7f809a1b2c3d4e5f6071';
  // A minimal manifest: no animation schema → convention-8x9 path.
  const CODEX_JSON = JSON.stringify({ id: 'mine', displayName: 'My Pet', spritesheetPath: 'spritesheet.webp' });

  beforeEach(() => query.mockClear());

  it('stores a valid upload under the server-derived slug and returns the descriptor', async () => {
    const sheet = webpVP8X(1536, 1872);
    const pet = await importPet({ petJsonText: CODEX_JSON, sheet, userId });

    expect(pet.slug).toBe(DERIVED_SLUG);
    expect(pet.displayName).toBe('My Pet');
    expect(pet.descriptor).toMatchObject({
      cols: 8, rows: 9, frameW: 192, frameH: 208, frameCount: 72,
      source: 'convention-8x9', hover: { start: 32, count: 5 },
      width: 1536, height: 1872,
    });

    // Persisted with the derived slug (bound param $1) and the sniffed mime ($5) — never
    // a client-chosen key.
    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe(DERIVED_SLUG);
    expect(params[4]).toBe('image/webp');
  });

  it('rejects a spritesheet over the 5 MB cap (TOO_LARGE) without storing', async () => {
    const oversized = Buffer.concat([webpVP8X(1536, 1872), Buffer.alloc(5 * 1024 * 1024)]);
    await expect(importPet({ petJsonText: CODEX_JSON, sheet: oversized, userId }))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects non-image bytes (BAD_IMAGE)', async () => {
    const junk = Buffer.from('this is plainly not an image, just prose bytes');
    await expect(importPet({ petJsonText: CODEX_JSON, sheet: junk, userId }))
      .rejects.toMatchObject({ code: 'BAD_IMAGE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects SVG masquerading as a spritesheet — no magic bytes (BAD_IMAGE)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1872"><rect/></svg>');
    await expect(importPet({ petJsonText: CODEX_JSON, sheet: svg, userId }))
      .rejects.toMatchObject({ code: 'BAD_IMAGE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid pet.json (BAD_JSON)', async () => {
    await expect(importPet({ petJsonText: '{ not valid json', sheet: webpVP8X(1536, 1872), userId }))
      .rejects.toMatchObject({ code: 'BAD_JSON' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a pet.json over the 256 KB cap before parsing (BAD_JSON)', async () => {
    const huge = JSON.stringify({ displayName: 'x'.repeat(300 * 1024) });
    await expect(importPet({ petJsonText: huge, sheet: webpVP8X(1536, 1872), userId }))
      .rejects.toMatchObject({ code: 'BAD_JSON' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a tiny file that declares giant header dimensions (BAD_IMAGE)', async () => {
    // A 30-byte WebP claiming 20000×20000 — the byte cap can't catch this, but the
    // dimension cap keeps it from driving an absurd frontend sprite layout.
    await expect(importPet({ petJsonText: CODEX_JSON, sheet: webpVP8X(20000, 20000), userId }))
      .rejects.toMatchObject({ code: 'BAD_IMAGE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a degenerate tiny sheet whose frame math collapses (BAD_META)', async () => {
    // 4×4 → the 8×9 convention derives frameW = floor(4/8) = 0 → parsePetJson returns null.
    await expect(importPet({ petJsonText: CODEX_JSON, sheet: png(4, 4), userId }))
      .rejects.toMatchObject({ code: 'BAD_META' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a missing user id, so the slug can never be forged (BAD_SLUG)', async () => {
    await expect(importPet({ petJsonText: CODEX_JSON, sheet: webpVP8X(1536, 1872), userId: null }))
      .rejects.toMatchObject({ code: 'BAD_SLUG' });
    expect(query).not.toHaveBeenCalled();
  });

  it('survives a hostile grid without crashing — clamps back to the 8×9 convention', async () => {
    // cols/rows in the billions would make frameW = floor(width/cols) = 0; parsePetJson's
    // guard resets to the derived 8×9 grid rather than emitting an absurd descriptor.
    const hostile = JSON.stringify({ displayName: 'H', cols: 1e9, rows: 1e9 });
    const pet = await importPet({ petJsonText: hostile, sheet: webpVP8X(1536, 1872), userId });
    expect(pet.descriptor).toMatchObject({ cols: 8, rows: 9, frameW: 192, frameH: 208, source: 'convention-8x9' });
  });

  it('coerces a JSON "null" pet.json to an empty manifest instead of throwing (slug fallback name)', async () => {
    // JSON text "null" parses to null and clears JSON.parse, then reaches the displayName read.
    // Dereferencing null there threw an UNCODED TypeError → the route's generic 500 rather than
    // a coded/validated response. A null manifest must instead store like an empty one: coerced
    // to {}, its display name falls back to the server-derived slug.
    const pet = await importPet({ petJsonText: 'null', sheet: webpVP8X(1536, 1872), userId });
    expect(pet.slug).toBe(DERIVED_SLUG);
    expect(pet.displayName).toBe(DERIVED_SLUG); // no displayName in a null manifest → slug fallback
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps __proto__ smuggled into pet.json off the derived descriptor (and off Object.prototype)', async () => {
    // JSON.parse puts "__proto__" as a harmless OWN key that never touches Object.prototype, so a
    // bare `{}.polluted` check is tautological — it can't fail against any implementation. What
    // actually matters is that the descriptor is built from KNOWN fields only: never
    // `Object.assign(descriptor, petJson)` (which would fire the __proto__ setter and expose
    // `polluted`) nor `{ ...petJson }` (which would copy an own `__proto__` key onto it). Assert
    // both, plus the global prototype, so an unsafe future refactor actually breaks this test.
    const polluted = '{"__proto__":{"polluted":"yes"},"displayName":"P","cols":8,"rows":9}';
    const pet = await importPet({ petJsonText: polluted, sheet: webpVP8X(1536, 1872), userId });
    expect(pet.descriptor.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(pet.descriptor, '__proto__')).toBe(false);
    expect({}.polluted).toBeUndefined();
  });
});
