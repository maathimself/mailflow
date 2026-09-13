import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../plugins/activation.js', () => ({
  getActivatedPlugins: vi.fn(),
  setPluginActivated: vi.fn(),
}));

import express from 'express';
import { pluginRegistry } from '../plugins/registry.js';
import { getActivatedPlugins, setPluginActivated } from '../plugins/activation.js';
import pluginsRoutes from './plugins.js';

const MANIFEST = { id: 'gtd', name: 'Getting Things Done', version: '1.0.0', tier: 1 };

let listSpy, hasSpy, runHookSpy;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', pluginsRoutes);
  app.use((err, _req, res, next) => { void err; void next; res.status(500).json({ error: 'Internal server error' }); });
  return app;
}

let server, base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  getActivatedPlugins.mockReset();
  setPluginActivated.mockReset().mockResolvedValue(new Set());
  listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([MANIFEST]);
  hasSpy = vi.spyOn(pluginRegistry, 'has').mockImplementation((id) => id === 'gtd');
  runHookSpy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
});
afterEach(() => { listSpy.mockRestore(); hasSpy.mockRestore(); runHookSpy.mockRestore(); });

const req = (method, path, body) => fetch(`${base}/api/plugins${path}`, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

describe('GET /api/plugins', () => {
  it('lists registered plugins with the user\'s activation state', async () => {
    getActivatedPlugins.mockResolvedValueOnce(new Set(['gtd']));
    const res = await req('GET', '/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 'gtd', name: 'Getting Things Done', version: '1.0.0', tier: 1, activated: true },
    ]);
  });

  it('reports activated=false when the user has not activated it', async () => {
    getActivatedPlugins.mockResolvedValueOnce(new Set());
    const res = await req('GET', '/');
    expect((await res.json())[0].activated).toBe(false);
  });
});

describe('PATCH /api/plugins/:id', () => {
  it('activates a plugin, fires onPluginActivationChanged, and echoes the state', async () => {
    const res = await req('PATCH', '/gtd', { activated: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'gtd', activated: true });
    expect(setPluginActivated).toHaveBeenCalledWith('u1', 'gtd', true);
    expect(runHookSpy).toHaveBeenCalledWith('onPluginActivationChanged', { userId: 'u1', pluginId: 'gtd', activated: true });
  });

  it('deactivates a plugin', async () => {
    const res = await req('PATCH', '/gtd', { activated: false });
    expect(res.status).toBe(200);
    expect(setPluginActivated).toHaveBeenCalledWith('u1', 'gtd', false);
    expect(runHookSpy).toHaveBeenCalledWith('onPluginActivationChanged', { userId: 'u1', pluginId: 'gtd', activated: false });
  });

  it('404s an unknown plugin without touching activation', async () => {
    const res = await req('PATCH', '/nope', { activated: true });
    expect(res.status).toBe(404);
    expect(setPluginActivated).not.toHaveBeenCalled();
    expect(runHookSpy).not.toHaveBeenCalled();
  });

  it('400s when activated is missing or non-boolean', async () => {
    expect((await req('PATCH', '/gtd', {})).status).toBe(400);
    expect((await req('PATCH', '/gtd', { activated: 'yes' })).status).toBe(400);
    expect(setPluginActivated).not.toHaveBeenCalled();
  });
});
