// The image proxy: remote images in an email load through MailFlow, so the sender's server sees
// MailFlow, not the reader's address, device or location, and the email frame can forbid every
// direct remote load. Only what the user has chosen to load goes through it (a sender they allow,
// or "Load images"); blocked images stay blocked.
//
// It is not an open proxy: GET /api/mail/messages/:id/image needs the user's session, and fetches
// a URL only when that exact reference appears in that message of theirs (remoteImageRefs). The
// fetch goes through safeFetch, which refuses private and reserved addresses on every redirect
// hop, whatever the admin's private-hosts setting, and plaintext HTTP.
//
// What comes back is served only if its bytes are a raster image of a known type, under a size
// limit; never SVG, which opened in a tab would be a document running on MailFlow's own origin. It
// is served under that detected type, with nosniff and a sandbox CSP, and cached privately by the
// browser for a day.
import { safeFetch } from './safeFetch.js';
import { readBodyLimited } from './senderFavicon.js';

export const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 15_000;
// A server that has not started answering by then is not going to: give the slot to the next image.
export const IMAGE_PROXY_HEADERS_TIMEOUT_MS = 8_000;
export const IMAGE_PROXY_PER_USER = 6;

// The proxy URL for a reference as written in a message's HTML. Percent-encoded beyond
// encodeURIComponent (which leaves ! ' ( ) * alone), so it is safe in any attribute, inline style
// or <style> block: only letters, digits, - . _ ~ % / ? = & remain. `width`, when the email gives
// the image one, is the width it is shown at, so the proxy can fit it (services/imageShrink.js).
// The frontend reverses it (utils/imageProxy.js); the two must agree.
export function imageProxyPath(messageId, raw, width = null) {
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const w = proxyWidth(width);
  return `/api/mail/messages/${messageId}/image?u=${encoded}${w ? `&w=${w}` : ''}`;
}

// A shown width worth passing on: a whole number of pixels, within reason.
export function proxyWidth(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 4000 ? n : null;
}

// The image type from the file's first bytes, or null: the upstream Content-Type is not trusted.
export function sniffImageType(bytes) {
  const b = bytes;
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif';
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  return null;
}

const failure = (status, reason) => Object.assign(new Error(reason), { status, reason });

async function cancelBody(body) {
  try { await body?.cancel?.(); } catch { /* best effort */ }
}

// Fetches one remote image. Returns { bytes, type }; throws an error carrying the HTTP status to
// answer with (404 nothing there, 413 too large, 415 not an image we serve, 502 upstream failed).
export async function fetchProxiedImage(url, {
  fetchImpl = safeFetch, timeoutMs = IMAGE_PROXY_TIMEOUT_MS, headersTimeoutMs = IMAGE_PROXY_HEADERS_TIMEOUT_MS,
  maxBytes = IMAGE_PROXY_MAX_BYTES,
} = {}) {
  let upstream;
  // Two limits: the answer must start within headersTimeoutMs, and be complete within timeoutMs.
  const headers = new AbortController();
  const headersTimer = setTimeout(() => headers.abort(), headersTimeoutMs);
  try {
    upstream = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.any([headers.signal, AbortSignal.timeout(timeoutMs)]),
      // No cookies, no referrer: a fresh request that says only what it is.
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; MailFlow image proxy)',
      },
    });
  } catch {
    throw failure(502, 'fetch failed');
  } finally {
    clearTimeout(headersTimer);
  }
  if (upstream.status !== 200) {
    await cancelBody(upstream.body);
    throw failure(upstream.status === 404 || upstream.status === 410 ? 404 : 502, `upstream ${upstream.status}`);
  }
  const declaredType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
  const declaredLength = Number(upstream.headers.get('content-length'));
  if (declaredType.includes('svg')) { await cancelBody(upstream.body); throw failure(415, 'svg'); }
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) { await cancelBody(upstream.body); throw failure(413, 'too large'); }
  let bytes;
  try {
    bytes = await readBodyLimited(upstream.body, maxBytes);
  } catch (error) {
    throw failure(error?.code === 'ERR_BODY_TOO_LARGE' ? 413 : 502, 'body failed');
  }
  const type = sniffImageType(bytes);
  if (!type) throw failure(415, 'not a raster image');
  return { bytes, type };
}

// At most IMAGE_PROXY_PER_USER fetches at once per user; the rest wait their turn. A newsletter
// asks for dozens of images together, and the sender's servers need not be hit all at once.
export function createUserLimiter(limit = IMAGE_PROXY_PER_USER) {
  const users = new Map();
  return async function run(userId, task) {
    let entry = users.get(userId);
    if (!entry) { entry = { active: 0, waiting: [] }; users.set(userId, entry); }
    if (entry.active >= limit) await new Promise((resolve) => entry.waiting.push(resolve));
    else entry.active += 1;
    try {
      return await task();
    } finally {
      const nextTask = entry.waiting.shift();
      if (nextTask) nextTask();
      else {
        entry.active -= 1;
        if (entry.active === 0) users.delete(userId);
      }
    }
  };
}
