// Port of internal/vector/embed/chunk.go, in code-point (rune) space. IMPORTANT: any
// change to the window/overlap/soft-break logic MUST bump EMBED_POLICY_VERSION in config.js.

const SENTENCE_TERMS = [['.', ' '], ['?', ' '], ['!', ' '], ['.', '\n'], ['?', '\n'], ['!', '\n']];

export const MAX_SPANS = 64; // worker.go maxSpansPerMessage

export function chunkOverlapFor(maxRunes) {
  if (maxRunes <= 0) return 0;
  if (maxRunes < 200) return 0;
  return Math.floor(maxRunes / 30);
}

// Largest i in [floor, ceil-2] with cps[i]===a && cps[i+1]===b, else -1.
function lastPair(cps, a, b, floor, ceil) {
  for (let i = ceil - 2; i >= floor; i--) if (cps[i] === a && cps[i + 1] === b) return i;
  return -1;
}
// Largest i in [floor, ceil-1] with cps[i]===ch, else -1.
function lastChar(cps, ch, floor, ceil) {
  for (let i = ceil - 1; i >= floor; i--) if (cps[i] === ch) return i;
  return -1;
}

// Return the code-point index of the preferred soft break in [floor, ceil): paragraph
// beats sentence beats word; ceil when none found.
function findSoftBreak(cps, floor, ceil) {
  const para = lastPair(cps, '\n', '\n', floor, ceil);
  if (para >= 0) return para + 2;

  let sentenceEnd = -1;
  let threshold = floor - 1;
  for (const [a, b] of SENTENCE_TERMS) {
    const start = lastPair(cps, a, b, floor, ceil);
    if (start >= 0 && start > threshold) { sentenceEnd = start + 2; threshold = start + 2; }
  }
  if (sentenceEnd >= 0) return sentenceEnd;

  const sp = lastChar(cps, ' ', floor, ceil);
  if (sp > floor) return sp + 1;

  return ceil;
}

export function chunkText(text, maxRunes, overlapRunes, maxSpans) {
  if (text === '') return { spans: [], tailDropped: false };
  if (maxRunes <= 0) return { spans: [{ text, charStart: 0, charEnd: Array.from(text).length }], tailDropped: false };

  let tailDropped = false;
  // Early cap WITHOUT materializing the whole input (guards the 10M-rune fixture).
  if (maxSpans > 0) {
    const keep = maxSpans * maxRunes;
    let count = 0, u16 = 0;
    for (const ch of text) {
      if (count >= keep) { text = text.slice(0, u16); tailDropped = true; break; }
      count++; u16 += ch.length;
    }
  }

  const cps = Array.from(text);
  const total = cps.length;
  if (total <= maxRunes) return { spans: [{ text: cps.join(''), charStart: 0, charEnd: total }], tailDropped };

  let overlap = overlapRunes < 0 ? 0 : overlapRunes;
  if (overlap >= maxRunes) overlap = Math.floor(maxRunes / 2);

  const spans = [];
  let cursor = 0;
  while (cursor < total) {
    if (maxSpans > 0 && spans.length >= maxSpans) { tailDropped = true; break; }
    const windowEnd = Math.min(cursor + maxRunes, total);
    let cut = windowEnd;
    if (windowEnd < total) {
      const searchFloor = Math.max(cursor + Math.floor((maxRunes * 3) / 4), cursor + 1);
      cut = findSoftBreak(cps, searchFloor, windowEnd);
    }
    spans.push({ text: cps.slice(cursor, cut).join(''), charStart: cursor, charEnd: cut });
    if (cut >= total) break;
    cursor += Math.max((cut - cursor) - overlap, 1);
  }
  return { spans, tailDropped };
}
