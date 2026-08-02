// All offsets are UTF-8 BYTES (msgvault wire contract). We operate on Buffers,
// never JS string .length (UTF-16 code units). Case-insensitive matching mirrors
// msgvault: find in the lowercased buffer, slice the original at the same offsets
// (ASCII-faithful; identical behavior to strings.ToLower + strings.Index in Go).
import { SNIPPET_BYTES, isRuneStart, lineNumberAt } from '../utils/textExcerpt.js';

export function contextWindow(bodyLen, pos, termLen, contextChars) {
  let start = pos - Math.floor((contextChars - termLen) / 2);
  let end = start + contextChars;
  if (start < 0) {
    start = 0;
    end = Math.min(bodyLen, contextChars);
  } else if (end > bodyLen) {
    end = bodyLen;
    start = Math.max(0, end - contextChars);
  }
  return [start, end];
}

export function bodyByteSliceRange(buf, start, end) {
  if (start < 0) start = 0;
  if (end > buf.length) end = buf.length;
  if (start >= buf.length) return { text: '', adjStart: buf.length, adjEnd: buf.length };
  let adjStart = start;
  let adjEnd = end <= start ? Math.min(buf.length, start + 1) : end;
  while (adjStart < adjEnd && !isRuneStart(buf[adjStart])) adjStart++;
  while (adjEnd > adjStart && adjEnd < buf.length && !isRuneStart(buf[adjEnd])) adjEnd--;
  return { text: buf.toString('utf8', adjStart, adjEnd), adjStart, adjEnd };
}

function bodyByteSlice(buf, start, end) {
  return bodyByteSliceRange(buf, start, end).text;
}

export function findTermMatches(body, term) {
  if (!body || !term) return [];
  const buf = Buffer.from(body, 'utf8');
  const lower = Buffer.from(body.toLowerCase(), 'utf8');
  const t = Buffer.from(term.toLowerCase(), 'utf8');
  const termLen = t.length;
  const matches = [];
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(t, from);
    if (idx < 0) break;
    from = idx + 1;
    const [start, end] = contextWindow(buf.length, idx, termLen, SNIPPET_BYTES);
    matches.push({ char_offset: idx, snippet: bodyByteSlice(buf, start, end), line: lineNumberAt(buf, idx) });
  }
  return matches;
}

export function extractContextChar(body, terms, contextChars) {
  if (!body || !terms || !terms.length || contextChars <= 0) return null;
  const buf = Buffer.from(body, 'utf8');
  const lower = Buffer.from(body.toLowerCase(), 'utf8');
  const spans = [];
  for (const term of terms) {
    if (!term || term.length < 2) continue;
    const t = Buffer.from(term.toLowerCase(), 'utf8');
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(t, from);
      if (idx < 0) break;
      from = idx + 1;
      spans.push(contextWindow(buf.length, idx, t.length, contextChars));
    }
  }
  if (!spans.length) return null;
  spans.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const merged = [spans[0].slice()];
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s.slice());
  }
  return merged.map(([s, e]) => bodyByteSlice(buf, s, e));
}
