import { describe, it, expect } from 'vitest';
import { SNIPPET_BYTES, isRuneStart, lineNumberAt } from './textExcerpt.js';

describe('SNIPPET_BYTES', () => {
  it('is the shared 300-byte excerpt width', () => {
    expect(SNIPPET_BYTES).toBe(300);
  });
});

describe('isRuneStart', () => {
  it('flags UTF-8 leading bytes, not continuation bytes', () => {
    const buf = Buffer.from('é', 'utf8'); // 0xC3 0xA9
    expect(isRuneStart(buf[0])).toBe(true);  // 0xC3 lead byte
    expect(isRuneStart(buf[1])).toBe(false); // 0xA9 continuation byte
    expect(isRuneStart(0x61)).toBe(true);    // ASCII 'a'
  });
});

describe('lineNumberAt', () => {
  it('counts newlines before the byte offset (1-based)', () => {
    const buf = Buffer.from('a\nb\nc', 'utf8');
    expect(lineNumberAt(buf, 0)).toBe(1);
    expect(lineNumberAt(buf, 2)).toBe(2);
    expect(lineNumberAt(buf, 4)).toBe(3);
  });
  it('clamps a negative or over-long offset', () => {
    const buf = Buffer.from('a\nb', 'utf8');
    expect(lineNumberAt(buf, -1)).toBe(1);
    expect(lineNumberAt(buf, 999)).toBe(2);
  });
});
