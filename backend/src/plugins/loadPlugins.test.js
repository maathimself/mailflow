import { describe, it, expect, vi } from 'vitest';

// gtd/index.js imports routes/gtd.js, which imports index.js (which starts the server).
// Mock the router module so this test only exercises registration, not the whole app.
vi.mock('../routes/gtd.js', () => ({ default: function gtdRouter() {} }));

import { createPluginRegistry } from './registry.js';
import { loadBundledPlugins } from './loadPlugins.js';

describe('loadBundledPlugins', () => {
  it('registers Templates as an optional Tier-1 plugin', () => {
    const registry = createPluginRegistry();
    loadBundledPlugins(registry);
    expect(registry.get('templates')).toMatchObject({ id: 'templates', tier: 1, router: { base: '/api/templates' } });
  });
  it('registers the GTD plugin as Tier-1 mounted at /api/gtd', () => {
    const r = createPluginRegistry();
    loadBundledPlugins(r);
    const gtd = r.get('gtd');
    expect(gtd).toBeTruthy();
    expect(gtd.tier).toBe(1);
    expect(gtd.router.base).toBe('/api/gtd');
    expect(typeof gtd.router.handler).toBe('function');
  });
});
