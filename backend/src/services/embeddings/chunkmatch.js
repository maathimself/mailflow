// Port of internal/vector/chunkmatch/matches.go. Converts stored vector chunk
// offsets (code points into the PREPROCESSED subject+body) into API-safe match
// excerpts: a snippet plus, only when the preprocessed chunk maps exactly and
// uniquely into the raw body, a raw-body BYTE char_offset and 1-based line.
//
// Two exports, both consumed by the MCP handler layer:
//   matchesInMessage — search_in_message mode=vector: re-embeds the query and the
//     message's freshly re-chunked text, scores, and builds excerpts. Gates on
//     resolveActiveGenerationFromConfig (throws VectorUnavailableError on stock/degraded PG).
//   matchFromChunk — semantic_search_messages: phase 4 already ranked and surfaced
//     the single best_chunk per hit, so no embedding — just re-derive the snippet
//     and map it back to a raw-body byte offset.
import { query } from '../db.js';
import { resolveActiveGenerationFromConfig } from './hybrid.js';               // phase-4 public face
import { EmbeddingClient } from './client.js';                                 // phase 3
import { chunkText, chunkOverlapFor, MAX_SPANS } from './chunk.js';            // phase 3 (shared chunking policy)
import { preprocess } from './preprocess.js';                                  // phase 3
import { RAW_BODY_MULT } from './worker.js';                                   // phase 3 (write-path body cap)
import { resolveEmbedConfig } from './config.js';                             // phase 1
import { SNIPPET_BYTES, isRuneStart, lineNumberAt } from '../../utils/textExcerpt.js';

// Preprocess options with the derived raw-body cap the worker applies at write time
// (worker.js _embedBatch). Without the same cap, a pathological body preprocesses to
// different text here than what was embedded, silently misaligning chunk offsets.
function derivedPreprocessCfg(cfg) {
  const pp = { ...((cfg && cfg.preprocess) || {}) };
  if (!pp.maxBodyRunes && cfg && cfg.maxInputChars > 0) {
    pp.maxBodyRunes = cfg.maxInputChars * MAX_SPANS * RAW_BODY_MULT;
  }
  return pp;
}

// First maxBytes of a UTF-8 buffer, never splitting a rune (msgvault bytePrefix).
function bytePrefix(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && !isRuneStart(buf[end])) end--;
  return buf.toString('utf8', 0, end);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Byte offset of chunk in the raw body, only if it occurs exactly once (msgvault uniqueBodyOffset).
function uniqueByteOffset(bodyBuf, chunkBuf) {
  const first = bodyBuf.indexOf(chunkBuf);
  if (first < 0 || bodyBuf.lastIndexOf(chunkBuf) !== first) return null;
  return first;
}

// The subject-prefix rune count preprocess.js prepends ("Subject: <s>\n\n"), or 0
// when the subject is empty (preprocess adds no prefix then). A chunk starting at
// or past this offset lies in the body region, so a raw-body offset is meaningful.
function subjectPrefixRunes(subject) {
  return subject ? [...('Subject: ' + subject + '\n\n')].length : 0;
}

// Scoped message load. Body selection matches worker.js (body_text unless blank,
// then body_html) so the preprocessed text — and thus the chunk offsets — align
// with what was embedded. Returns null when the message is out of scope.
async function loadMessage(messageId, accountIds) {
  const { rows } = await query(
    'SELECT subject, body_text, body_html FROM messages WHERE id = $1 AND account_id = ANY($2)',
    [messageId, accountIds],
  );
  if (!rows.length) return null;
  const subject = rows[0].subject || '';
  const bodyText = rows[0].body_text;
  const rawBody = bodyText && bodyText.trim() !== '' ? bodyText : (rows[0].body_html || '');
  return { subject, rawBody };
}

export async function matchesInMessage(messageId, queryText, minScore, { accountIds }) {
  const q = (queryText || '').trim();
  if (!q) return [];

  const { cfg } = await resolveActiveGenerationFromConfig();

  const msg = await loadMessage(messageId, accountIds);
  if (!msg) return [];
  const { subject, rawBody } = msg;
  if (!rawBody) return [];

  const { text: preprocessed } = preprocess(subject, rawBody, 0, derivedPreprocessCfg(cfg));
  const prefixRunes = subjectPrefixRunes(subject);
  const window = cfg.maxInputChars || 0;
  const { spans } = chunkText(preprocessed, window, chunkOverlapFor(window), MAX_SPANS);
  if (!spans.length) return [];

  // Re-embed the query plus every chunk. Embeddings are deterministic for a given
  // model+input, so re-embedding the chunk text yields the same vectors the stored
  // chunks carry — the equivalent of msgvault's ScoreMessageChunks. The inputs
  // (1 query + up to MAX_SPANS chunks) are embedded in slices of cfg.batchSize,
  // the same per-call budget the worker's write path honors.
  const client = new EmbeddingClient(cfg);
  const inputs = [q, ...spans.map((s) => s.text)];
  const batchSize = cfg.batchSize > 0 ? cfg.batchSize : 32;
  const vecs = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    vecs.push(...await client.embed(inputs.slice(i, i + batchSize)));
  }
  const queryVec = vecs[0];
  const bodyBuf = Buffer.from(rawBody, 'utf8');
  const min = Number.isFinite(minScore) ? minScore : 0;

  return spans
    .map((span, i) => ({ span, score: cosine(queryVec, vecs[i + 1]) }))
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score)
    .map(({ span, score }) => {
      const chunkBuf = Buffer.from(span.text, 'utf8');
      const m = { snippet: bytePrefix(chunkBuf, SNIPPET_BYTES), score };
      if (span.charStart >= prefixRunes) {
        const off = uniqueByteOffset(bodyBuf, chunkBuf);
        if (off !== null) { m.char_offset = off; m.line = lineNumberAt(bodyBuf, off); }
      }
      return m;
    });
}

export async function matchFromChunk(messageId, bestChunk, { accountIds }) {
  if (!bestChunk) return null;
  const msg = await loadMessage(messageId, accountIds);
  if (!msg) return null;
  const { subject, rawBody } = msg;

  const cfg = await resolveEmbedConfig();
  const { text: preprocessed } = preprocess(subject, rawBody, 0, derivedPreprocessCfg(cfg));
  const prefixRunes = subjectPrefixRunes(subject);
  const cps = [...preprocessed]; // code points — the domain phase-4 char_start/char_end index into
  const start = Math.max(0, bestChunk.char_start | 0);
  const end = Math.min(cps.length, bestChunk.char_end | 0);
  if (end <= start) return null;

  const chunkStr = cps.slice(start, end).join('');
  const chunkBuf = Buffer.from(chunkStr, 'utf8');
  const match = { snippet: bytePrefix(chunkBuf, SNIPPET_BYTES), score: bestChunk.score };
  if (start >= prefixRunes && rawBody) {
    const bodyBuf = Buffer.from(rawBody, 'utf8');
    const off = uniqueByteOffset(bodyBuf, chunkBuf);
    if (off !== null) { match.char_offset = off; match.line = lineNumberAt(bodyBuf, off); }
  }
  return match;
}
