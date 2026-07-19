import { describe, it, expect } from 'vitest';
import { contextWindow, bodyByteSliceRange, extractContextChar, findTermMatches } from './bodyMatch.js';

describe('contextWindow', () => {
  it('centers within bounds', () => {
    expect(contextWindow(1000, 500, 10, 300)).toEqual([355, 655]);
  });
  it('clamps at the start', () => {
    expect(contextWindow(1000, 5, 10, 300)).toEqual([0, 300]);
  });
  it('clamps at the end', () => {
    expect(contextWindow(300, 290, 4, 300)).toEqual([0, 300]);
  });
});

describe('byte-offset fidelity on multibyte bodies', () => {
  // "café — " then the term. 'é' is 2 bytes (0xC3 0xA9), '—' is 3 bytes.
  const body = 'café — meeting notes';
  it('findTermMatches reports the BYTE offset of the term, not the code-unit index', () => {
    const m = findTermMatches(body, 'meeting');
    // "café — " = c a f é(2) space —(3) space = 1+1+1+2+1+3+1 = 10 bytes
    expect(m).toHaveLength(1);
    expect(m[0].char_offset).toBe(10);
    expect(m[0].line).toBe(1);
    expect(m[0].snippet).toContain('meeting');
  });
  it('bodyByteSliceRange never splits a rune', () => {
    const buf = Buffer.from(body, 'utf8');
    // Ask for a window that would cut the 'é' (bytes 3-4) in half at byte 4.
    const { text } = bodyByteSliceRange(buf, 0, 4);
    expect(Buffer.from(text, 'utf8').every((b) => b !== undefined)).toBe(true);
    expect(text).toBe('caf'); // é dropped rather than split
  });
});

describe('extractContextChar', () => {
  it('merges overlapping windows into snippet strings', () => {
    const body = 'alpha beta alpha';
    const snippets = extractContextChar(body, ['alpha'], 300);
    expect(snippets).toHaveLength(1); // both hits merge into one window
    expect(snippets[0]).toContain('alpha');
  });
  it('ignores terms shorter than 2 chars', () => {
    expect(extractContextChar('a a a', ['a'], 300)).toBeNull();
  });
});
