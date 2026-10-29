import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
import { query } from '../services/db.js';
import * as storage from './storage.js';

describe('plugin storage', () => {
  beforeEach(() => query.mockReset());

  it('lists values for one plugin and owner, rejecting an unscoped list', async () => {
    query.mockResolvedValue({ rows: [{ key: 'k1', owner_id: 'u1', value: { name: 'Welcome' } }] });
    expect(await storage.listValues('templates', 'u1')).toHaveLength(1);
    expect(query.mock.calls[0][0]).toMatch(/WHERE plugin_id = \$1 AND owner_id = \$2/);
    expect(query.mock.calls[0][1]).toEqual(['templates', 'u1']);
    await expect(storage.listValues('templates')).rejects.toThrow('owner');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('put upserts by (plugin_id, key) carrying value/blob/owner/visibility', async () => {
    query.mockResolvedValue({ rows: [] });
    const blob = Buffer.from('x');
    await storage.put('gtd', 'k1', { value: { a: 1 }, blob, mime: 'image/webp', ownerId: 'u1', visibility: 'private' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO plugin_data/);
    expect(sql).toMatch(/ON CONFLICT \(plugin_id, key\) DO UPDATE/);
    expect(params.slice(0, 3)).toEqual(['gtd', 'k1', 'u1']);
    expect(params[3]).toBe(JSON.stringify({ a: 1 }));
    expect(params[4]).toBe(blob);
    expect(params[5]).toBe('image/webp');
    expect(params[6]).toBe('private');
  });

  it('put applies safe defaults (empty value, no owner, private)', async () => {
    query.mockResolvedValue({ rows: [] });
    await storage.put('p', 'k');
    const [, params] = query.mock.calls[0];
    expect(params[2]).toBeNull();     // ownerId
    expect(params[3]).toBe('{}');     // value
    expect(params[4]).toBeNull();     // blob
    expect(params[6]).toBe('private');
  });

  it('getValue / getBlob return the row or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ key: 'k1', owner_id: null, value: { a: 1 }, visibility: 'public' }] });
    expect(await storage.getValue('gtd', 'k1')).toEqual({ key: 'k1', owner_id: null, value: { a: 1 }, visibility: 'public' });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await storage.getValue('gtd', 'missing')).toBeNull();

    const b = Buffer.from('y');
    query.mockResolvedValueOnce({ rows: [{ blob: b, blob_mime: 'image/png', owner_id: 'u1', visibility: 'private' }] });
    expect(await storage.getBlob('gtd', 'k1')).toEqual({ blob: b, blob_mime: 'image/png', owner_id: 'u1', visibility: 'private' });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await storage.getBlob('gtd', 'x')).toBeNull();
  });
});
