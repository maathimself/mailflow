// Low-level UTF-8 / line primitives shared by the excerpt builders on both search
// paths: mcp/bodyMatch.js (keyword matches) and services/embeddings/chunkmatch.js
// (vector chunk matches). All offsets are UTF-8 BYTES (msgvault wire contract). The
// higher-level keyword-vs-chunk assembly stays in each owner; only these primitives
// live here so they cannot drift.

// Default snippet width in bytes for a match excerpt.
export const SNIPPET_BYTES = 300;

// True when `byte` is a UTF-8 leading byte (not a 10xxxxxx continuation byte), so a
// slice boundary at it does not split a multi-byte rune.
export const isRuneStart = (byte) => (byte & 0xc0) !== 0x80;

// 1-based line number at a byte offset: one plus the count of '\n' bytes before it.
export function lineNumberAt(buf, byteOffset) {
  if (byteOffset <= 0) return 1;
  const o = Math.min(byteOffset, buf.length);
  let n = 1;
  for (let i = 0; i < o; i++) if (buf[i] === 0x0a) n++;
  return n;
}
