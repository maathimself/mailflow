import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
const { resolveLookupPhoto, resolveLookupPhotos, _clearLookupPhotoCache } = await import('./carddavLookupService.js');

const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PHOTO_B64 = PHOTO_BYTES.toString('base64');

function lookupVCard(photo) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:lookup-1',
    'FN:Lookup Sender',
    'EMAIL:sender@example.test',
    ...(photo ? [`PHOTO;ENCODING=b;TYPE=JPEG:${photo}`] : []),
    'END:VCARD',
  ].join('\r\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearLookupPhotoCache();
});

describe('resolveLookupPhoto', () => {
  it('decodes the retained vCard PHOTO from a lookup-only book by email', async () => {
    query.mockResolvedValueOnce({ rows: [{ vcard: lookupVCard(PHOTO_B64) }] });

    const photo = await resolveLookupPhoto('user-1', 'Sender@Example.test');

    expect(photo).toEqual({ mime: 'image/jpeg', bytes: PHOTO_BYTES });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("o.mapping_status = 'lookup'");
    expect(sql).toContain('ab.is_lookup_source = true');
    expect(sql).toContain("ab.source = 'carddav'");
    // Email is normalized to lower-case before the ledger probe.
    expect(params).toEqual(['user-1', 'sender@example.test']);
  });

  it('memoizes the decoded avatar so a repeat request skips the DB and re-parse', async () => {
    query.mockResolvedValueOnce({ rows: [{ vcard: lookupVCard(PHOTO_B64) }] });

    const first = await resolveLookupPhoto('user-1', 'sender@example.test');
    const second = await resolveLookupPhoto('user-1', 'sender@example.test');

    expect(second).toEqual(first);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('memoizes a miss so an absent sender is not re-queried on every message row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    expect(await resolveLookupPhoto('user-1', 'nobody@example.test')).toBeNull();
    expect(await resolveLookupPhoto('user-1', 'nobody@example.test')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns null when the lookup vCard carries no PHOTO', async () => {
    query.mockResolvedValueOnce({ rows: [{ vcard: lookupVCard(null) }] });

    expect(await resolveLookupPhoto('user-1', 'sender@example.test')).toBeNull();
  });

  it('refuses to serve a PHOTO that exceeds the bounded decode limit', async () => {
    // 600 KiB of decoded image (819,200 base64 chars) — over decodeBase64Photo's
    // 512 KiB ceiling but under the 1 MiB vCard limit. It MUST be line-folded:
    // as one physical line it would trip the parser's 64 KiB physical-line limit
    // first and the test would pass even with the size bound deleted. Folded into
    // <64 KiB physical lines, the parser unfolds it cleanly and the 512 KiB PHOTO
    // bound is the check that rejects it (delete that bound and this goes red).
    const oversized = 'A'.repeat(819_200);
    const CHUNK = 8_000;
    const photoLines = [`PHOTO;ENCODING=b;TYPE=JPEG:${oversized.slice(0, CHUNK)}`];
    for (let index = CHUNK; index < oversized.length; index += CHUNK) {
      photoLines.push(` ${oversized.slice(index, index + CHUNK)}`);
    }
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:lookup-1',
      'FN:Lookup Sender',
      'EMAIL:sender@example.test',
      ...photoLines,
      'END:VCARD',
    ].join('\r\n');
    query.mockResolvedValueOnce({ rows: [{ vcard }] });

    expect(await resolveLookupPhoto('user-1', 'sender@example.test')).toBeNull();
  });

  it('returns null for a blank email without touching the DB', async () => {
    expect(await resolveLookupPhoto('user-1', '   ')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('resolveLookupPhotos (batched)', () => {
  it('resolves N distinct senders in a single DB round-trip', async () => {
    query.mockResolvedValueOnce({ rows: [
      { primary_email: 'alice@example.test', vcard: lookupVCard(PHOTO_B64) },
      { primary_email: 'carol@example.test', vcard: lookupVCard(PHOTO_B64) },
    ] });

    const photos = await resolveLookupPhotos('user-1', [
      'Alice@Example.test', 'bob@example.test', 'carol@example.test',
    ]);

    // One probe for the whole page — never one per distinct sender.
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('primary_email = ANY($2::text[])');
    expect(sql).toContain('DISTINCT ON (o.primary_email)');
    // Deduped and lower-cased before the probe.
    expect(params).toEqual([
      'user-1',
      ['alice@example.test', 'bob@example.test', 'carol@example.test'],
    ]);
    expect(photos.get('alice@example.test')).toEqual({ mime: 'image/jpeg', bytes: PHOTO_BYTES });
    expect(photos.get('carol@example.test')).toEqual({ mime: 'image/jpeg', bytes: PHOTO_BYTES });
    // A candidate with no ledger row resolves to a memoized null, not undefined.
    expect(photos.get('bob@example.test')).toBeNull();
  });

  it('serves cache hits without a probe and shares the cache with resolveLookupPhoto', async () => {
    query.mockResolvedValueOnce({ rows: [
      { primary_email: 'alice@example.test', vcard: lookupVCard(PHOTO_B64) },
    ] });

    await resolveLookupPhotos('user-1', ['alice@example.test']);
    expect(query).toHaveBeenCalledTimes(1);

    // A second batch for the same sender is fully cached — no new probe.
    const again = await resolveLookupPhotos('user-1', ['Alice@Example.test']);
    expect(again.get('alice@example.test')).toEqual({ mime: 'image/jpeg', bytes: PHOTO_BYTES });
    // The single-email route reads the same primed entry the batch wrote.
    expect(await resolveLookupPhoto('user-1', 'alice@example.test'))
      .toEqual({ mime: 'image/jpeg', bytes: PHOTO_BYTES });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('issues no query for an empty or blank-only candidate set', async () => {
    expect(await resolveLookupPhotos('user-1', [])).toEqual(new Map());
    expect(await resolveLookupPhotos('user-1', ['', '   '])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});
