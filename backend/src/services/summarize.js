import { completeText } from './aiProvider.js';
import { aiFeatureEnabled, getUserAiAccess } from './aiAccess.js';

// Generic "summarize a message into one line" capability (v3.0 plugin platform).
//
// A safe primitive any feature — and, once the boundary is finished, a sandboxed plugin —
// can call to turn a message into a short human line WITHOUT touching the AI provider, its
// keys, or the feature gate directly. GTD's "waiting" gist is the first consumer.
//
// The pure pieces (prompt building, output sanitising) are exported and unit-tested; the
// provider call fails closed — returns null, never throws — so a summary is always
// best-effort and a caller's own work never fails just because AI is down or misbehaves.

const SUMMARY_MAX_LEN = 120;

// Build the one-line-summary prompt for a message. Pure — the load-bearing decision (what we
// ask the model for) is unit-testable without a provider.
export function buildSummaryPrompt({ subject, from, content, maxLen = SUMMARY_MAX_LEN } = {}) {
  const body = (content || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return `Condense this email into ONE line of at most ${maxLen} characters.
Rules: plain text only, no quotation marks, no emoji, present tense. Capture what the sender said and what happens next. Reply with only the line, nothing else.

From: ${from || '(unknown)'}
Subject: ${(subject || '').slice(0, 200)}
Body: ${body}`;
}

// Strip emoji ("no emoji" rule) while leaving accented letters and CJK intact so non-English
// summaries survive: pictographs + regional-indicator flags via Unicode property escapes, then
// the zero-width joiner / variation selectors / keycap combiner that stitch emoji sequences
// together (removed with single-char escapes — a character class of combining chars trips
// no-misleading-character-class).
function stripEmoji(s) {
  return s
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, '')
    .replace(/‍/g, '')  // zero-width joiner
    .replace(/︎/g, '')  // variation selector-15 (text)
    .replace(/️/g, '')  // variation selector-16 (emoji)
    .replace(/⃣/g, ''); // combining enclosing keycap
}

// Sanitise a model response into a single clean ≤maxLen line, or null when the output is
// unusable. Pure. Takes the first non-empty line, strips wrapping quotes and emoji, collapses
// whitespace, and hard-caps the length.
export function sanitizeSummaryLine(raw, maxLen = SUMMARY_MAX_LEN) {
  if (typeof raw !== 'string') return null;
  let s = (raw.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) || '');
  s = s.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '');
  s = stripEmoji(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || null;
}

// Is summarization available right now, for this user? Checks provider availability through the
// shared adapter, the summarize feature gate, and the user's own AI access (#644), which also
// denies a missing userId. Fails closed so a caller never fails just because AI is down. Callers
// that batch should gate on this ONCE before doing per-message work.
export async function summarizeAvailable(userId) {
  try {
    const { status, allowed } = await getUserAiAccess(userId);
    return allowed && aiFeatureEnabled(status, 'summarize');
  } catch {
    return false;
  }
}

// Summarize one message into a sanitised ≤maxLen line for this user, or null when AI is not
// available to them (the same check as summarizeAvailable, so a plugin cannot skip the gate,
// #644), the output is unusable, or the provider errors. Never throws. A batching caller should
// still gate on summarizeAvailable() once up front, so a user without access costs no per-message
// work.
export async function summarizeMessage({ userId, subject, from, content, maxLen = SUMMARY_MAX_LEN } = {}) {
  try {
    if (!await summarizeAvailable(userId)) return null;
    const response = await completeText(
      [{ role: 'user', content: buildSummaryPrompt({ subject, from, content, maxLen }) }],
      { maxTokens: maxLen }
    );
    return sanitizeSummaryLine(response, maxLen);
  } catch {
    return null;
  }
}
