import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api.js', () => ({
  storage: {
    listByOwner: vi.fn(),
    getValue: vi.fn(),
    getBlob: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock('node:crypto', () => ({ randomUUID: vi.fn() }));

import { storage } from '../api.js';
import { randomUUID } from 'node:crypto';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from './templateStorage.js';

const USER = 'user-1';
const ID = 'aaaa-bbbb';
const KEY = `template:${USER}:${ID}`;

const baseValue = {
  id: ID,
  name: 'My Template',
  description: '',
  blocks: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listTemplates', () => {
  it('returns parsed template values for the user', async () => {
    storage.listByOwner.mockResolvedValue({
      rows: [
        { key: `template:${USER}:id1`, owner_id: USER, value: { id: 'id1', name: 'A' } },
        { key: `template:${USER}:id2`, owner_id: USER, value: { id: 'id2', name: 'B' } },
      ],
    });
    const result = await listTemplates(USER);
    expect(result).toEqual([{ id: 'id1', name: 'A' }, { id: 'id2', name: 'B' }]);
    expect(storage.listByOwner).toHaveBeenCalledWith('template-builder', USER);
  });

  it('filters out keys not belonging to the user prefix', async () => {
    storage.listByOwner.mockResolvedValue({
      rows: [
        { key: `template:other-user:id1`, owner_id: 'other-user', value: { id: 'id1' } },
        { key: `template:${USER}:id2`, owner_id: USER, value: { id: 'id2', name: 'B' } },
      ],
    });
    const result = await listTemplates(USER);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('id2');
  });

  it('returns empty array when user has no templates', async () => {
    storage.listByOwner.mockResolvedValue({ rows: [] });
    expect(await listTemplates(USER)).toEqual([]);
  });
});

describe('getTemplate', () => {
  it('returns template with html blob', async () => {
    storage.getValue.mockResolvedValue({ owner_id: USER, value: baseValue });
    storage.getBlob.mockResolvedValue({ blob: Buffer.from('<html>ok</html>'), blob_mime: 'text/html' });
    const result = await getTemplate(USER, ID);
    expect(result).toMatchObject({ ...baseValue, html: '<html>ok</html>' });
  });

  it('returns null when key does not exist', async () => {
    storage.getValue.mockResolvedValue(null);
    expect(await getTemplate(USER, ID)).toBeNull();
  });

  it('returns null when owner does not match', async () => {
    storage.getValue.mockResolvedValue({ owner_id: 'other', value: baseValue });
    expect(await getTemplate(USER, ID)).toBeNull();
  });

  it('returns html: null when blob is absent', async () => {
    storage.getValue.mockResolvedValue({ owner_id: USER, value: baseValue });
    storage.getBlob.mockResolvedValue(null);
    const result = await getTemplate(USER, ID);
    expect(result.html).toBeNull();
  });
});

describe('createTemplate', () => {
  it('stores the template and returns its metadata', async () => {
    randomUUID.mockReturnValue(ID);
    storage.put.mockResolvedValue();
    const result = await createTemplate(USER, { name: 'My Template', blocks: [] });
    expect(result.id).toBe(ID);
    expect(result.name).toBe('My Template');
    expect(storage.put).toHaveBeenCalledWith(
      'template-builder',
      KEY,
      expect.objectContaining({ value: expect.objectContaining({ id: ID }), ownerId: USER })
    );
  });
});

describe('updateTemplate', () => {
  it('merges fields and returns updated metadata', async () => {
    storage.getValue.mockResolvedValue({ owner_id: USER, value: baseValue });
    storage.put.mockResolvedValue();
    const result = await updateTemplate(USER, ID, { name: 'Updated', html: '<html>new</html>' });
    expect(result.name).toBe('Updated');
    expect(storage.put).toHaveBeenCalledWith(
      'template-builder',
      KEY,
      expect.objectContaining({ blob: Buffer.from('<html>new</html>'), mime: 'text/html' })
    );
  });

  it('returns null when template does not exist', async () => {
    storage.getValue.mockResolvedValue(null);
    expect(await updateTemplate(USER, ID, { name: 'X' })).toBeNull();
  });

  it('returns null when owner does not match', async () => {
    storage.getValue.mockResolvedValue({ owner_id: 'other', value: baseValue });
    expect(await updateTemplate(USER, ID, { name: 'X' })).toBeNull();
  });
});

describe('deleteTemplate', () => {
  it('deletes and returns true', async () => {
    storage.getValue.mockResolvedValue({ owner_id: USER, value: baseValue });
    storage.del.mockResolvedValue();
    expect(await deleteTemplate(USER, ID)).toBe(true);
    expect(storage.del).toHaveBeenCalledWith('template-builder', KEY);
  });

  it('returns false when template does not exist', async () => {
    storage.getValue.mockResolvedValue(null);
    expect(await deleteTemplate(USER, ID)).toBe(false);
  });

  it('returns false when owner does not match', async () => {
    storage.getValue.mockResolvedValue({ owner_id: 'other', value: baseValue });
    expect(await deleteTemplate(USER, ID)).toBe(false);
  });
});
