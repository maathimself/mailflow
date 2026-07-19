import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpBearerAuth } from './auth.js';
import { TOOL_DEFS, HANDLERS } from './tools.js';
import { errorResult } from './result.js';

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

// --- Per-token tool-call rate limit -----------------------------------------------
// REST search is limited per user (routes/search.js); the MCP surface reuses the same
// in-memory bucket pattern, keyed by the api_tokens row id — NOT the client IP, since
// many agents legitimately share one egress. Only tools/call requests count, so the
// initialize / tools-list handshake a stateless client repeats is never throttled.
// Over-limit requests get an HTTP 429 with Retry-After BEFORE the transport, carrying
// the SDK's JSON-RPC error envelope shape. Default 60 tool calls per minute per token,
// overridable via MCP_RATE_LIMIT_PER_MIN.
export function countToolCalls(body) {
  if (Array.isArray(body)) return body.filter((m) => m && m.method === 'tools/call').length;
  return body && body.method === 'tools/call' ? 1 : 0;
}

export function createMcpRateLimiter({ limit, windowMs = 60_000, now = Date.now } = {}) {
  const envLimit = Number(process.env.MCP_RATE_LIMIT_PER_MIN);
  const max = limit ?? (envLimit > 0 ? envLimit : 60);
  const buckets = new Map();
  const sweeper = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (t > b.resetAt) buckets.delete(k);
  }, windowMs);
  sweeper.unref?.(); // observability sweeper must never keep the process alive

  return (req, res, next) => {
    const calls = countToolCalls(req.body);
    if (!calls) return next();
    const t = now();
    let b = buckets.get(req.mcpTokenId);
    if (!b || t > b.resetAt) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(req.mcpTokenId, b);
    }
    if (b.count + calls > max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - t) / 1000));
      return res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Rate limit exceeded: at most ${max} tool calls per minute per token — retry shortly` },
        id: Array.isArray(req.body) ? null : (req.body?.id ?? null),
      });
    }
    b.count += calls;
    next();
  };
}

// Build a fresh Server bound to one request's scope. Stateless: no session store,
// one Server+transport per HTTP request, matching msgvault's daemon-less posture.
function buildServer(scope) {
  const server = new Server(
    { name: 'mailflow', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = HANDLERS[req.params.name];
    if (!handler) return errorResult(`unknown tool: ${req.params.name}`);
    try {
      return await handler(req.params.arguments || {}, scope);
    } catch (err) {
      // Tool-level failures flow as isError results, not JSON-RPC errors,
      // so the client sees a readable message (msgvault convention).
      return errorResult(`internal error: ${err.message}`);
    }
  });

  return server;
}

export function mountMcp(app) {
  const handle = async (req, res) => {
    const server = buildServer(req.mcpScope);
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
