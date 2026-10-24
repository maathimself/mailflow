import { describe, expect, it, vi } from 'vitest';

// Only the routers' route tables are read; no request is made.
vi.mock('./db.js', () => ({ query: vi.fn(), pool: {}, withTransaction: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { readFileSync } from 'fs';
import mailRoutes from '../routes/mail.js';
import sendRoutes from '../routes/send.js';
import draftRoutes from '../routes/draft.js';
import accountRoutes from '../routes/accounts.js';
import { accountSpamRouter } from '../routes/spam.js';
import searchRoutes from '../routes/search.js';
import apiTokenRoutes from '../routes/apiTokens.js';
import aiRoutes from '../routes/ai.js';
import categoriesRoutes from '../routes/categories.js';
import { loadBundledPlugins } from '../plugins/loadPlugins.js';
import { API_TOKEN_ROUTES, matchApiTokenRoute } from './apiTokenAllowlist.js';

// The routers index.js mounts where an allowlisted request can reach them, by the names it mounts
// them under. REVIEWED are those whose routes were reviewed for API tokens; ai and categories sit
// under /api ahead of the inline routes, so a request walks through them too.
const ROUTERS = { mailRoutes, sendRoutes, draftRoutes, accountRoutes, accountSpamRouter, searchRoutes, apiTokenRoutes, aiRoutes, categoriesRoutes };
const REVIEWED = new Set(['mailRoutes', 'sendRoutes', 'draftRoutes', 'accountRoutes', 'accountSpamRouter', 'searchRoutes', 'apiTokenRoutes']);
// Routes index.js defines itself, reviewed for any valid token.
const INLINE = ['/api/health', '/api/version'];

const ID = '6f1c1c84-5d2b-4b8e-9d0c-2f6b1c7a9e31';
const shape = path => path.replace(/:\w+/g, ':param');

// index.js's routing in its own order, read from its source so that a prefix it changes, a router
// it drops or one it mounts ahead of another cannot go unnoticed. Every app.use there has to be
// one of the forms below, or this cannot tell what it reaches.
const INDEX = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const ROUTING = (() => {
  const plugins = [];
  loadBundledPlugins({ register: plugin => plugins.push(plugin) });
  const routing = [];
  const STATEMENT = /app\.use\((.*)|^app\.(get|post|put|patch|delete|all)\('([^']+)',/gm;
  for (const [, use, method, path] of INDEX.matchAll(STATEMENT)) {
    if (method) {
      routing.push({ owner: 'index.js', method: method.toUpperCase(), path });
      continue;
    }
    const mount = /^'([^']+)', (\w+)\);$/.exec(use.trim());
    if (mount) routing.push({ owner: mount[2], prefix: mount[1], router: ROUTERS[mount[2]] });
    else if (use.startsWith('plugin.router.base, plugin.router.handler)')) {
      for (const plugin of plugins.filter(p => p.router)) {
        routing.push({ owner: `plugin ${plugin.id}`, prefix: plugin.router.base, router: plugin.router.handler });
      }
    } else if (!use.startsWith('(') && !use.startsWith('corsExceptDav(')) {
      // Middleware is an inline function or the CORS wrapper; anything else may be a router.
      throw new Error(`index.js has an app.use this test cannot read: app.use(${use.slice(0, 60)}`);
    }
  }
  return routing;
})();

const covers = (prefix, url) => url === prefix || url.startsWith(`${prefix}/`);

// The route Express hands a concrete request to, walking index.js's routing as Express does.
function dispatch(method, url) {
  for (const step of ROUTING) {
    if (step.owner === 'index.js') {
      if (step.path === url && (step.method === method || step.method === 'ALL')) return { method, path: url, owner: step.owner };
      continue;
    }
    if (!covers(step.prefix, url)) continue;
    if (!step.router) throw new Error(`index.js mounts ${step.owner} at ${step.prefix}, where ${method} ${url} can reach it: import it here`);
    const rest = url.slice(step.prefix.length) || '/';
    for (const layer of step.router.stack) {
      if (!layer.route && layer.handle?.stack && layer.match(rest)) {
        throw new Error(`${step.owner} nests a router where ${method} ${url} can reach it, which this walk does not read`);
      }
      if (layer.route && layer.match(rest) && layer.route._handles_method(method)) {
        return { method, path: step.prefix + (layer.route.path === '/' ? '' : layer.route.path), owner: step.owner };
      }
    }
  }
  return null;
}

// Every (method, path) the routers mounted in index.js serve. Express answers HEAD with a GET route.
function servedRoutes() {
  const served = [];
  for (const { prefix, router, owner } of ROUTING.filter(step => step.router)) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      expect(typeof layer.route.path, `${owner} route ${String(layer.route.path)}`).toBe('string');
      const path = prefix + (layer.route.path === '/' ? '' : layer.route.path);
      for (const method of Object.keys(layer.route.methods)) {
        served.push({ method: method.toUpperCase(), path });
        if (method === 'get') served.push({ method: 'HEAD', path });
      }
    }
  }
  return served;
}

describe('the API token allowlist against the routers', () => {
  it('reads every reviewed router and both inline routes out of index.js', () => {
    for (const owner of REVIEWED) expect(ROUTING.some(step => step.owner === owner), owner).toBe(true);
    for (const path of INLINE) expect(ROUTING.some(step => step.owner === 'index.js' && step.path === path), path).toBe(true);
  });

  it('names a real route for every entry, the one index.js hands its requests to, where it was reviewed', () => {
    for (const entry of API_TOKEN_ROUTES) {
      const label = `${entry.method} ${entry.path}`;
      // No route registered earlier, in another router, a literal sibling or a parameter route, takes the request first.
      const reached = dispatch(entry.method, entry.path.replaceAll(':uuid', ID));
      expect(reached && shape(reached.path), label).toBe(shape(entry.path));
      if (reached.owner === 'index.js') expect(INLINE, label).toContain(entry.path);
      else expect(REVIEWED.has(reached.owner), `${label} is served by ${reached.owner}`).toBe(true);
    }
  });

  it('refuses every other route under those prefixes', () => {
    const allowed = new Set(API_TOKEN_ROUTES.map(r => `${r.method} ${shape(r.path)}`));
    const refused = servedRoutes().filter(r => !allowed.has(`${r.method} ${shape(r.path)}`));
    // Enough of the routers was walked for this to mean something.
    expect(refused.length).toBeGreaterThan(50);
    for (const { method, path } of refused) {
      // A UUID wherever the route takes a parameter is the likeliest value to slip through, and a
      // literal sibling's name the likeliest to be taken for another route.
      for (const value of [ID, '1', 'bulk-read']) {
        const url = path.replace(/:\w+/g, value);
        const entry = matchApiTokenRoute(method, url);
        if (!entry) continue;
        // Taken by the matcher, so Express must hand it to that entry's own route.
        const reached = dispatch(method, url);
        expect(reached && `${reached.method} ${shape(reached.path)}`, `${method} ${url}`).toBe(`${entry.method} ${shape(entry.path)}`);
      }
    }
  });

  it('refuses the allowlisted paths for every method no entry names', () => {
    for (const entry of API_TOKEN_ROUTES) {
      const url = entry.path.replaceAll(':uuid', ID);
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const listed = API_TOKEN_ROUTES.find(r => r.method === method && r.path === entry.path) ?? null;
        expect(matchApiTokenRoute(method, url), `${method} ${url}`).toBe(listed);
      }
    }
  });
});
