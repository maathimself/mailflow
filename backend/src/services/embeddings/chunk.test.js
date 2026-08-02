import { describe, it, expect } from 'vitest';
import { chunkText, chunkOverlapFor, MAX_SPANS } from './chunk.js';

const cp = (s) => Array.from(s).length;

// Pin the shared chunking policy chunk.js owns. worker.js (write path) and chunkmatch.js
// (read path) both import MAX_SPANS + chunkOverlapFor from here, so they cannot drift —
// a mismatch would silently misalign re-chunked read offsets from stored write offsets.
describe('shared chunking policy (one owner)', () => {
  it('exports MAX_SPANS = 64 (worker.go maxSpansPerMessage)', () => {
    expect(MAX_SPANS).toBe(64);
  });
  it('chunkOverlapFor: 0 below 200 runes, floor(maxRunes/30) at or above', () => {
    expect(chunkOverlapFor(0)).toBe(0);
    expect(chunkOverlapFor(-5)).toBe(0);
    expect(chunkOverlapFor(199)).toBe(0);
    expect(chunkOverlapFor(200)).toBe(6);      // floor(200/30)
    expect(chunkOverlapFor(3000)).toBe(100);
  });
});

describe('chunkText (msgvault fixture parity)', () => {
  it('EmptyInputReturnsNil', () => { expect(chunkText('', 100, 10, 0).spans).toEqual([]); });

  it('ShortInputReturnsSingleSpan', () => {
    const { spans } = chunkText('hello world', 100, 10, 0);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('hello world');
    expect(spans[0].charStart).toBe(0);
    expect(spans[0].charEnd).toBe(11);
  });

  it('MaxRunesZeroDisablesChunking', () => {
    const text = 'x'.repeat(1000);
    const { spans } = chunkText(text, 0, 10, 0);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe(text);
  });

  it('CutsAtParagraphBreakInBackQuarter', () => {
    const text = 'a'.repeat(80) + '\n\n' + 'b'.repeat(50);
    const { spans } = chunkText(text, 100, 10, 0);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0].charEnd).toBe(82);
    expect(spans[0].text.endsWith('\n\n')).toBe(true);
  });

  it('CutsAtSentenceBoundaryWhenNoParagraph', () => {
    const text = 'a'.repeat(80) + '. ' + 'b'.repeat(50);
    const { spans } = chunkText(text, 100, 10, 0);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0].charEnd).toBe(82);
  });

  it('CutsAtWordBoundaryWhenNoSentence', () => {
    const text = 'a'.repeat(90) + ' ' + 'b'.repeat(50);
    const { spans } = chunkText(text, 100, 10, 0);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0].charEnd).toBe(91);
  });

  it('HardCutsWhenNoSoftBreakInBackQuarter', () => {
    const { spans } = chunkText('a'.repeat(1000), 100, 0, 0);
    expect(spans).toHaveLength(10);
    for (const s of spans) expect(s.charEnd - s.charStart).toBe(100);
  });

  it('OverlapBetweenConsecutiveChunks', () => {
    const { spans } = chunkText('a'.repeat(300), 100, 20, 0);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[1].charStart).toBe(80);
  });

  it('OverlapClampedToHalfWindow', () => {
    const { spans } = chunkText('a'.repeat(300), 100, 500, 0);
    expect(spans.length).toBeGreaterThan(0);
    if (spans.length >= 2) expect(spans[1].charStart).toBe(50);
  });

  it('AllSpansHaveValidUTF8AndCorrectText', () => {
    let text = '';
    for (let i = 0; i < 50; i++) text += 'Hello world. ' + 'こんにちは世界。';
    const { spans } = chunkText(text, 80, 10, 0);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    const runes = Array.from(text);
    for (const s of spans) {
      expect(s.charStart).toBeGreaterThanOrEqual(0);
      expect(s.charEnd).toBeLessThanOrEqual(runes.length);
      expect(s.charStart).toBeLessThan(s.charEnd);
      expect(s.text).toBe(runes.slice(s.charStart, s.charEnd).join(''));
    }
  });

  it('MaxSpansCapsInputBytesProcessed', () => {
    const text = 'a'.repeat(10_000_000);
    const t0 = Date.now();
    const { spans } = chunkText(text, 100, 0, 3);
    expect(spans).toHaveLength(3);
    for (const s of spans) expect(s.charEnd).toBeLessThanOrEqual(300);
    expect(Date.now() - t0).toBeLessThan(500); // O(cap), not O(10M)
  });

  it('MaxSpansCapsOutputAndDropsTail', () => {
    const { spans } = chunkText('a'.repeat(1000), 100, 0, 3);
    expect(spans).toHaveLength(3);
    expect(spans[0].charStart).toBe(0);
    expect(spans[spans.length - 1].charEnd).toBeLessThan(1000);
  });

  it('TailDroppedFlagsCapWhenLastChunkLandsOnSoftBreak', () => {
    let text = '';
    for (let i = 0; i < 5; i++) text += 'a'.repeat(85) + '. ';
    const { spans, tailDropped } = chunkText(text, 90, 0, 2);
    expect(spans).toHaveLength(2);
    expect(tailDropped).toBe(true);
  });

  it('TailDroppedFalseWhenAllContentEmitted', () => {
    const { spans, tailDropped } = chunkText('a'.repeat(150), 100, 0, 10);
    expect(spans.length).toBeGreaterThan(0);
    expect(tailDropped).toBe(false);
  });

  it('MaxSpansZeroIsUnlimited', () => { expect(chunkText('a'.repeat(1000), 100, 0, 0).spans).toHaveLength(10); });
  it('MaxSpansLargerThanNaturalChunkCountIsNoop', () => { expect(chunkText('a'.repeat(300), 100, 0, 100).spans).toHaveLength(3); });

  it('ConcatenationCoversInputModuloOverlap', () => {
    const text = 'Lorem ipsum dolor sit amet. '.repeat(200);
    const { spans } = chunkText(text, 200, 30, 0);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0].charStart).toBe(0);
    expect(spans[spans.length - 1].charEnd).toBe(cp(text));
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].charStart).toBeLessThanOrEqual(spans[i - 1].charEnd);
    }
  });
});
