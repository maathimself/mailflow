import { describe, it, expect } from 'vitest';
import { safeFilename, attachmentDisposition, truncateFilename } from './contentDisposition.js';

// Build all non-ASCII inputs from char codes so this source stays pure ASCII (no invisible chars).
const cjk = String.fromCharCode(0x767a, 0x7968) + '.pdf'; // 発票.pdf
const withControl = 'a' + String.fromCharCode(0x00, 0x1f) + 'b.pdf';
const withRLO = 'a' + String.fromCharCode(0x202e) + 'b.pdf'; // right-to-left override
const withIsolates = 'a' + String.fromCharCode(0x2066, 0x2069) + 'b.pdf';
const emoji = String.fromCodePoint(0x1f600); // two UTF-16 units (a surrogate pair)
const loneHigh = String.fromCharCode(0xd83d); // the first half of that pair, on its own

// What Node's res.setHeader accepts without throwing ERR_INVALID_CHAR: no code point outside
// printable ASCII. (Node also permits \x80-\xFF, but our builder never emits those.)
const headerSafe = (v) => !/[^\x20-\x7e]/.test(v);

describe('safeFilename', () => {
  it('keeps a normal ASCII name', () => {
    expect(safeFilename('invoice.pdf')).toBe('invoice.pdf');
  });
  it('keeps Unicode (correct for a UTF-8 zip entry name)', () => {
    expect(safeFilename(cjk)).toBe(cjk);
  });
  it('replaces path separators with underscore', () => {
    expect(safeFilename('a/b\\c.pdf')).toBe('a_b_c.pdf');
  });
  it('strips control characters', () => {
    expect(safeFilename(withControl)).toBe('ab.pdf');
  });
  it('strips bidi override / isolate characters (extension-spoofing guard)', () => {
    expect(safeFilename(withRLO)).toBe('ab.pdf');
    expect(safeFilename(withIsolates)).toBe('ab.pdf');
  });
  it('falls back to "attachment" for empty/blank input', () => {
    expect(safeFilename('')).toBe('attachment');
    expect(safeFilename(null)).toBe('attachment');
    expect(safeFilename('   ')).toBe('attachment');
  });
  it('caps length at 255', () => {
    expect(safeFilename('a'.repeat(300))).toHaveLength(255);
  });
  it('drops an emoji split by the 255 cap rather than leaving half of it', () => {
    expect(safeFilename('a'.repeat(254) + emoji + 'b')).toBe('a'.repeat(254));
  });
  it('replaces a lone surrogate so the name stays well-formed', () => {
    expect(safeFilename('a' + loneHigh + '.pdf')).toBe('a' + String.fromCharCode(0xfffd) + '.pdf');
  });
});

describe('truncateFilename', () => {
  it('leaves a name within the limit alone', () => {
    expect(truncateFilename('report', 80)).toBe('report');
  });
  it('cuts a BMP-only name at exactly the limit', () => {
    expect(truncateFilename('a'.repeat(100), 80)).toBe('a'.repeat(80));
  });
  it('keeps an emoji that ends exactly at the limit', () => {
    expect(truncateFilename('a'.repeat(78) + emoji + 'b', 80)).toBe('a'.repeat(78) + emoji);
  });
  it('drops an emoji that straddles the limit instead of splitting its surrogate pair', () => {
    const cut = truncateFilename('a'.repeat(79) + emoji + 'b', 80);
    expect(cut).toBe('a'.repeat(79));
    expect(cut.isWellFormed()).toBe(true);
  });
});

describe('attachmentDisposition', () => {
  it('emits a header-safe value for an ASCII name', () => {
    const v = attachmentDisposition('report.pdf');
    expect(v).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(headerSafe(v)).toBe(true);
  });

  it('never emits a value res.setHeader would reject for a CJK name (#367)', () => {
    const v = attachmentDisposition(cjk);
    expect(headerSafe(v)).toBe(true);                 // the actual crash regression
    expect(v).toMatch(/filename="_+\.pdf"/);          // non-ASCII -> underscores in the quoted fallback
    const ext = v.match(/filename\*=UTF-8''(.+)$/)[1];
    expect(decodeURIComponent(ext)).toBe(cjk);        // real Unicode name preserved + round-trips
  });

  it('neutralizes " and \\ that would break the quoted-string', () => {
    const v = attachmentDisposition('a"b\\c.pdf');
    expect(v).toContain('filename="a_b_c.pdf"');
    expect(headerSafe(v)).toBe(true);
  });

  it("percent-encodes the RFC 5987 stragglers ' ( ) * in filename*", () => {
    const v = attachmentDisposition("a'(b)*.pdf");
    const ext = v.match(/filename\*=UTF-8''(.+)$/)[1];
    expect(ext).not.toMatch(/['()*]/);                // no unencoded attr-char violations
    expect(decodeURIComponent(ext)).toBe("a'(b)*.pdf"); // still round-trips
    expect(headerSafe(v)).toBe(true);
  });

  it('does not throw on a lone surrogate (encodeURIComponent would: URIError)', () => {
    const v = attachmentDisposition('x'.repeat(79) + loneHigh + '.eml');
    expect(headerSafe(v)).toBe(true);
    const ext = v.match(/filename\*=UTF-8''(.+)$/)[1];
    expect(decodeURIComponent(ext)).toBe('x'.repeat(79) + String.fromCharCode(0xfffd) + '.eml');
  });

  it('falls back to "attachment" for an empty name', () => {
    expect(attachmentDisposition('')).toBe(`attachment; filename="attachment"; filename*=UTF-8''attachment`);
  });
});
