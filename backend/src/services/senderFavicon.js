import crypto from 'node:crypto';
import net from 'node:net';
import { domainToASCII } from 'node:url';
import { redisClient } from './redis.js';
import { safeFetch } from './safeFetch.js';

const PROVIDER_ORIGIN = 'https://twenty-icons.com';
const MAX_BYTES = 65_536;
const MAX_DIMENSION = 64;
const POSITIVE_TTL = 7 * 24 * 60 * 60;
const DEFINITIVE_TTL = 6 * 60 * 60;
const TRANSIENT_TTL = 5 * 60;
// No legitimate mail sender exceeds ten labels; the cap bounds the parent-walk
// recursion at the front door so a crafted 253-char domain is rejected outright.
const MAX_LABELS = 10;
const inflight = new Map();
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Pragmatic (NOT exhaustive) multi-label public suffixes: the parent walk never
// queries one and never strips a subdomain down into one. No PSL dependency.
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'sch.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.tw', 'com.cn', 'com.hk', 'com.tr', 'com.ua',
  'co.in', 'co.za', 'co.nz', 'co.kr', 'co.il',
  'github.io',
]);

export function normalizeSenderDomain(value) {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw || /[@/:\\\s?#]/.test(raw)) return null;
  if (raw.endsWith('.')) raw = raw.slice(0, -1);
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || net.isIP(ascii) || !ascii.includes('.')) return null;
  const labels = ascii.split('.');
  if (labels.length > MAX_LABELS) return null;
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return ascii;
}

export async function readBodyLimited(body, maxBytes = MAX_BYTES) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        throw Object.assign(new Error('Response body is too large'), { code: 'ERR_BODY_TOO_LARGE' });
      }
      chunks.push(bytes);
    }
  } catch (error) {
    try { await body.cancel?.(error); } catch { /* best effort */ }
    throw error;
  }
  return Buffer.concat(chunks, size);
}

export function validateSquarePng(buffer, maxDimension = MAX_DIMENSION) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return false;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width >= 1 && width === height && width <= maxDimension;
}

function cacheKey(domain) {
  const digest = crypto.createHash('sha256').update(domain).digest('hex');
  return `sender-favicon:v2:${digest}`;
}

// Registrable-domain walk: strip ONE leading label, keeping ≥2 labels and never
// crossing into a listed public suffix. Returns the single parent candidate or
// null at the boundary. Resolution recurses one parent per level; the MAX_LABELS
// cap in normalize bounds the chain, so a domain's full ancestry is reached.
function nextParent(domain) {
  const labels = domain.split('.').slice(1);
  if (labels.length < 2) return null;
  const candidate = labels.join('.');
  return PUBLIC_SUFFIXES.has(candidate) ? null : candidate;
}

function miss(reason) {
  return { kind: 'miss', reason };
}

function ttlFor(result) {
  if (result.kind === 'image') return POSITIVE_TTL;
  return result.reason === 'transient' ? TRANSIENT_TTL : DEFINITIVE_TTL;
}

function serialize(result) {
  return JSON.stringify(result.kind === 'image'
    ? { v: 1, kind: 'image', pngBase64: result.bytes.toString('base64') }
    : { v: 1, kind: 'miss', reason: result.reason });
}

function parseCached(value) {
  const entry = JSON.parse(value);
  if (entry?.v !== 1) throw new Error('Unknown favicon cache version');
  if (entry.kind === 'miss' && ['not-found', 'invalid-image', 'transient'].includes(entry.reason)) {
    return miss(entry.reason);
  }
  if (entry.kind === 'image' && typeof entry.pngBase64 === 'string') {
    const bytes = Buffer.from(entry.pngBase64, 'base64');
    if (bytes.length <= MAX_BYTES && validateSquarePng(bytes, MAX_DIMENSION)) {
      return { kind: 'image', bytes, source: 'cache' };
    }
  }
  throw new Error('Invalid favicon cache entry');
}

async function cancelBody(body) {
  try { await body?.cancel?.(); } catch { /* best effort */ }
}

async function fetchProvider(domain, { fetchImpl, timeoutMs, maxBytes }) {
  try {
    const upstream = await fetchImpl(`${PROVIDER_ORIGIN}/${encodeURIComponent(domain)}/64`, {
      headers: { Accept: 'image/png' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (upstream.status !== 200) {
      await cancelBody(upstream.body);
      // Only 400 (unresolvable, e.g. mail-only subdomains), 404, and 410 are
      // definitive absence for this exact domain and eligible for the parent
      // walk; every other non-200 (auth, rate-limit, timeout, 5xx) is retryable.
      return [400, 404, 410].includes(upstream.status) ? miss('not-found') : miss('transient');
    }
    const type = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const declared = Number(upstream.headers.get('content-length'));
    if (type !== 'image/png' || (Number.isFinite(declared) && declared > maxBytes)) {
      await cancelBody(upstream.body);
      return miss('invalid-image');
    }
    const bytes = await readBodyLimited(upstream.body, maxBytes);
    return validateSquarePng(bytes, MAX_DIMENSION)
      ? { kind: 'image', bytes, source: 'upstream' }
      : miss('invalid-image');
  } catch (error) {
    return error?.code === 'ERR_BODY_TOO_LARGE' ? miss('invalid-image') : miss('transient');
  }
}

async function cacheResult(cache, domain, result) {
  try { await cache.set(cacheKey(domain), serialize(result), { EX: ttlFor(result) }); }
  catch { /* current validated bytes may still be returned */ }
}

// One domain resolved through the shared cache + inflight machinery. The cache
// entry and the inflight promise always carry the domain's fully resolved
// outcome (image or its final miss), so sibling subdomains reuse it and
// concurrent callers — direct or walking — dedupe onto the same resolution.
async function resolveDomain(domain, deps) {
  const key = cacheKey(domain);
  let cached;
  try { cached = await deps.cache.get(key); }
  catch { return miss('cache-unavailable'); }
  if (cached != null) {
    try { return parseCached(cached); }
    catch {
      try { await deps.cache.del(key); } catch { /* best effort */ }
    }
  }
  if (inflight.has(domain)) return inflight.get(domain);
  const pending = resolveWithParents(domain, deps).finally(() => inflight.delete(domain));
  inflight.set(domain, pending);
  return pending;
}

// Resolve a domain to its own true outcome: fetch it, and on a definitive
// not-found recurse into its single registrable parent (never on transient or
// invalid-image, and a transient/timeout at any level stops the chain). An image
// found upstream wins; a transient or cache-unavailable parent degrades this
// domain to a retryable transient; any other parent miss leaves the not-found
// standing. Resolution is context-free — the result depends only on the domain,
// never on which caller started the walk — so the outcome cached under this
// domain's own key means direct and indirect lookups can never disagree.
async function resolveWithParents(domain, deps) {
  let result = await fetchProvider(domain, deps);
  if (result.kind === 'miss' && result.reason === 'not-found') {
    const parent = nextParent(domain);
    if (parent) {
      const step = await resolveDomain(parent, deps);
      if (step.kind === 'image') result = step;
      else if (step.reason === 'transient' || step.reason === 'cache-unavailable') result = miss('transient');
    }
  }
  await cacheResult(deps.cache, domain, result);
  return result;
}

export async function getSenderFavicon(domain, {
  cache = redisClient,
  fetchImpl = safeFetch,
  timeoutMs = 5000,
  maxBytes = MAX_BYTES,
} = {}) {
  const normalized = normalizeSenderDomain(domain);
  if (!normalized) return miss('invalid-image');
  return resolveDomain(normalized, { cache, fetchImpl, timeoutMs, maxBytes });
}
