import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { hasScope, mcpBearerAuth } from './auth.js';
import { TOOL_DEFS, TOOL_SCOPES, HANDLERS } from './tools.js';
import { errorResult } from './result.js';
import { listRules } from './accountAdapter.js';

// Attachments are base64-inlined in MCP tool arguments, so this parser needs the
// same headroom as the REST send/draft routes. index.js mounts it before the
// global 1 MB parser.
export function mcpBodyLimit() {
  return express.json({ limit: process.env.MCP_BODY_LIMIT || '35mb' });
}

export function entityTooLargeResponse(err, path) {
  if (err?.type !== 'entity.too.large') return null;
  if (path.startsWith('/mcp')) {
    return {
      status: 413,
      body: {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Request too large (max 35 MB).' },
        id: null,
      },
    };
  }
  return {
    status: 413,
    body: {
      error: 'Request too large. Total attachment size must not exceed 25 MB.',
    },
  };
}

// --- Origin validation (DNS-rebinding protection) --------------------------------
// The MCP Streamable HTTP spec REQUIRES servers to validate the Origin header so a
// malicious web page cannot drive a local MCP endpoint from a victim's browser via
// DNS rebinding. Our SDK (@modelcontextprotocol/sdk 1.29) can enforce this in the
// transport (`enableDnsRebindingProtection` + `allowedOrigins` on
// WebStandardStreamableHTTPServerTransport) but ships with it DISABLED by default
// (GHSA-w48q-cv73-mx4w) and compares origins by exact string match. We enforce at
// the Express layer instead: one owner, normalized (URL.origin, lowercased)
// comparison, and rejection happens before bearer auth ever touches the database.
//
// Policy (mirrors websocket.js): a request with NO Origin header passes — MCP
// clients are non-browser processes and send none. A request WITH an Origin must
// resolve to an allowlisted origin: APP_URL, FRONTEND_URL, any localhost /
// 127.0.0.1 / [::1] origin on any port (a DNS-rebinding page always presents the
// attacker's hostname as Origin, never localhost), or an operator-supplied extra
// via MCP_ALLOWED_ORIGINS (comma-separated URLs, e.g. "https://lan-host:8087").
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function buildAllowedOrigins(env = process.env) {
  const allowed = new Set();
  const add = (raw) => {
    if (!raw || !raw.trim()) return;
    try { allowed.add(new URL(raw.trim()).origin.toLowerCase()); }
    catch { /* malformed allowlist entry — skip it rather than fail the boot */ }
  };
  add(env.APP_URL);
  add(env.FRONTEND_URL);
  for (const entry of (env.MCP_ALLOWED_ORIGINS || '').split(',')) add(entry);
  return allowed;
}

export function mcpOriginGuard(allowed = buildAllowedOrigins()) {
  return (req, res, next) => {
    const raw = req.get('Origin');
    if (!raw) return next(); // non-browser MCP client
    try {
      const url = new URL(raw);
      if (allowed.has(url.origin.toLowerCase()) || LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) {
        return next();
      }
    } catch { /* unparseable Origin (including the literal "null") — reject below */ }
    // Same JSON-RPC error envelope the SDK transport uses for its own HTTP-level
    // rejections (webStandardStreamableHttp.js createJsonErrorResponse).
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Origin not allowed: ${raw}` },
      id: null,
    });
  };
}

// --- Per-token tool-call rate limits ----------------------------------------------
// REST search is limited per user (routes/search.js); the MCP surface reuses the same
// in-memory bucket pattern, keyed by the api_tokens row id — NOT the client IP, since
// many agents legitimately share one egress. Only tools/call requests count, so the
// initialize / tools-list handshake a stateless client repeats is never throttled.
// Over-limit requests get an HTTP 429 with Retry-After BEFORE the transport, carrying
// the SDK's JSON-RPC error envelope shape. Read/write/send/settings have independent
// per-minute budgets, and send also has a per-token daily cap.
export function countToolCalls(body) {
  if (Array.isArray(body)) return body.filter((m) => m && m.method === 'tools/call').length;
  return body && body.method === 'tools/call' ? 1 : 0;
}

const RATE_CLASSES = ['read', 'write', 'send', 'settings'];

export function classifyToolCalls(body) {
  const counts = { read: 0, write: 0, send: 0, settings: 0 };
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || message.method !== 'tools/call') continue;
    const required = TOOL_SCOPES[message.params?.name];
    // Array scopes use AND semantics at authorization. For rate limiting, the
    // first-listed scope is the primary/most-restrictive class. No current tool
    // has an array scope; this pins the forward-looking tie-break explicitly.
    const primary = Array.isArray(required) ? required[0] : required;
    const rateClass = RATE_CLASSES.includes(primary) ? primary : 'read';
    counts[rateClass]++;
  }
  return counts;
}

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return value > 0 ? value : fallback;
}

export function createMcpRateLimiter({ limits, windowMs = 60_000, now = Date.now } = {}) {
  const maximums = {
    read: limits?.read ?? positiveEnv('MCP_RATE_LIMIT_PER_MIN', 60),
    write: limits?.write ?? positiveEnv('MCP_WRITE_RATE_LIMIT_PER_MIN', 30),
    send: limits?.send ?? positiveEnv('MCP_SEND_RATE_LIMIT_PER_MIN', 10),
    settings: limits?.settings ?? positiveEnv('MCP_SETTINGS_RATE_LIMIT_PER_MIN', 10),
  };
  const dailySendMax = positiveEnv('MCP_SEND_DAILY_CAP', 200);
  const dayMs = 24 * 60 * 60 * 1000;
  const buckets = new Map();
  const sweeper = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (t >= b.resetAt) buckets.delete(k);
  }, windowMs);
  sweeper.unref?.(); // observability sweeper must never keep the process alive

  const bucketFor = (key, duration, t) => {
    let bucket = buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + duration };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const reject = (req, res, bucket, max, rateClass, period, t) => {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - t) / 1000));
    return res.status(429).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Rate limit exceeded: at most ${max} ${rateClass} tool calls per ${period} per token`,
      },
      id: Array.isArray(req.body) ? null : (req.body?.id ?? null),
    });
  };

  return (req, res, next) => {
    const calls = classifyToolCalls(req.body);
    if (!RATE_CLASSES.some((rateClass) => calls[rateClass] > 0)) return next();
    const t = now();
    const admissions = [];
    for (const rateClass of RATE_CLASSES) {
      if (!calls[rateClass]) continue;
      const bucket = bucketFor(`${req.mcpTokenId}:${rateClass}`, windowMs, t);
      if (bucket.count + calls[rateClass] > maximums[rateClass]) {
        return reject(req, res, bucket, maximums[rateClass], rateClass, 'minute', t);
      }
      admissions.push([bucket, calls[rateClass]]);
    }

    if (calls.send) {
      const daily = bucketFor(`${req.mcpTokenId}:send:day`, dayMs, t);
      if (daily.count + calls.send > dailySendMax) {
        return reject(req, res, daily, dailySendMax, 'send', 'day', t);
      }
      admissions.push([daily, calls.send]);
    }

    // Admit only after every affected bucket passes, so a rejected batch consumes
    // no budget in any class.
    for (const [bucket, count] of admissions) bucket.count += count;
    next();
  };
}

// Build a fresh Server bound to one request's scope. Stateless: no session store,
// one Server+transport per HTTP request, matching msgvault's daemon-less posture.
export function buildServer(scope, deps = {}) {
  const server = new Server(
    { name: 'mailflow', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.filter((definition) => hasScope(scope, TOOL_SCOPES[definition.name])),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const handler = HANDLERS[name];
    if (!handler) return errorResult(`unknown tool: ${name}`);
    const requiredScope = TOOL_SCOPES[name];
    if (!requiredScope) {
      return errorResult(`permission_denied: tool "${name}" has no scope classification`);
    }
    if (!hasScope(scope, requiredScope)) {
      return errorResult(
        `permission_denied: tool "${name}" requires the "${requiredScope}" scope; ` +
        `this token has [${(scope.scopes || []).join(', ')}]`,
      );
    }
    try {
      return await handler(req.params.arguments || {}, scope, deps);
    } catch (err) {
      // Tool-level failures flow as isError results, not JSON-RPC errors,
      // so the client sees a readable message (msgvault convention).
      return errorResult(`internal error: ${err.message}`);
    }
  });

  return server;
}

export function mountMcp(app, deps = {}) {
  // get_triage_context's matched-rules section needs a read-only rules loader;
  // the adapter's scoped listRules is the natural default, overridable in tests.
  const resolvedDeps = { loadInboxRules: listRules, ...deps };
  const handle = async (req, res) => {
    const server = buildServer(req.mcpScope, resolvedDeps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    // Global express.json already parsed the body; hand it to the transport.
    await transport.handleRequest(req, res, req.body);
  };

  const originGuard = mcpOriginGuard(buildAllowedOrigins());
  const rateLimiter = createMcpRateLimiter();

  // Tool calls only arrive as POST bodies; GET (SSE open) and DELETE (session
  // teardown) carry none, so the rate limiter guards POST alone.
  app.post('/mcp', originGuard, mcpBearerAuth, rateLimiter, handle);
  app.get('/mcp', originGuard, mcpBearerAuth, handle);
  app.delete('/mcp', originGuard, mcpBearerAuth, handle);
}
