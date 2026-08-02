// Port of internal/vector/embed/client.go.

export class Permanent4xxError extends Error {
  constructor(message) { super(message); this.name = 'Permanent4xxError'; this.permanent4xx = true; }
}
export function isPermanent4xx(err) { return err instanceof Permanent4xxError || err?.permanent4xx === true; }

function parseRetryAfter(v) {
  if (!v) return null;
  const s = String(v).trim();
  const MAX = 3600 * 1000;
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, MAX);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const d = t - Date.now(); return d <= 0 ? 0 : Math.min(d, MAX); }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort drain of a response body we are about to abandon. undici keeps the
// socket checked out until the body is consumed or cancelled; the retry paths
// (429/5xx) throw without decoding a body, so drain here to release the connection
// back to the pool before we back off and retry — otherwise a burst of rate
// limiting across scheduler ticks leaks connections. Errors are swallowed: a failed
// drain must not mask the retryable status we are reporting.
async function drainBody(resp) {
  try { await resp.text(); } catch { /* already released/aborted — nothing to free */ }
}

export class EmbeddingClient {
  // `dimension` is the expected vector length; every returned embedding is asserted
  // against it. Pass null/undefined to skip the assertion — the admin test-embeddings
  // probe does this because its job is to DISCOVER the endpoint's real dimension.
  // Worker/query paths always construct with the configured dimension.
  constructor({ endpoint, apiKey, model, dimension, timeout = 30000, maxRetries = 3 }) {
    this.endpoint = endpoint;
    this.apiKey = apiKey || null;
    this.model = model;
    this.dimension = dimension ?? null;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
  }

  async embed(inputs) {
    if (!inputs.length) return [];
    const body = JSON.stringify({ input: inputs, model: this.model });
    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._doOnce(body, inputs.length);
      } catch (err) {
        lastErr = err;
        if (!err._retry) throw err; // permanent 4xx or dimension mismatch — no retry
        if (attempt === this.maxRetries) break;
        let backoff = Math.min(2 ** Math.min(attempt, 8), 256) * 100;
        if (err._retryAfterSet) backoff = err._retryAfter;
        if (backoff > 0) await sleep(backoff);
      }
    }
    throw new Error(`embed: giving up after ${this.maxRetries} attempts: ${lastErr.message}`);
  }

  async _doOnce(body, want) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let resp;
    try {
      resp = await fetch(`${this.endpoint}/embeddings`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeout) });
    } catch (e) { const err = new Error(`http do: ${e.message}`); err._retry = true; throw err; }

    if (resp.status === 429) {
      const ra = parseRetryAfter(resp.headers.get('Retry-After'));
      await drainBody(resp); // free the socket before backing off — we discard this body
      const err = new Error('embed: HTTP 429 (rate limited)'); err._retry = true;
      if (ra !== null) { err._retryAfterSet = true; err._retryAfter = ra; }
      throw err;
    }
    if (resp.status >= 500) {
      await drainBody(resp); // free the socket before retrying — we discard this body
      const err = new Error(`embed: HTTP ${resp.status}`); err._retry = true; throw err;
    }
    if (resp.status >= 400) {
      const txt = (await resp.text().catch(() => '')).slice(0, 4096).trim();
      throw new Permanent4xxError(`embed: HTTP ${resp.status}${txt ? ': ' + txt : ''}`);
    }
    let data;
    try { data = await resp.json(); } catch (e) { const err = new Error(`decode response: ${e.message}`); err._retry = true; throw err; }

    const vecs = new Array(want).fill(null);
    for (const d of data.data || []) {
      if (d.index < 0 || d.index >= want) throw new Error(`embed: invalid index ${d.index} (len=${want})`);
      if (this.dimension !== null && d.embedding.length !== this.dimension) {
        throw new Error(`embed: dimension mismatch: got ${d.embedding.length}, configured ${this.dimension}`);
      }
      vecs[d.index] = d.embedding;
    }
    for (let i = 0; i < want; i++) if (vecs[i] === null) throw new Error(`embed: missing embedding at index ${i}`);
    return vecs;
  }
}
