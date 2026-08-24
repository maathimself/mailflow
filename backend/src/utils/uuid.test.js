import { describe, it, expect, vi } from 'vitest';
import { isUuid, uuidParam } from './uuid.js';

describe('uuid util', () => {
  it('isUuid accepts valid UUIDs and rejects junk', () => {
    expect(isUuid('f5629d01-414d-4c70-8dc8-616478ddcc46')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid("f5629d01-414d-4c70-8dc8-616478ddcc46'; DROP")).toBe(false);
  });

  it('uuidParam returns 400 on a malformed value and does not call next', () => {
    const req = {}, next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    uuidParam('id')(req, res, next, 'bogus');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid id' });
    expect(next).not.toHaveBeenCalled();
  });

  it('uuidParam calls next() on a valid UUID and sends no response', () => {
    const req = {}, next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    uuidParam('aliasId')(req, res, next, 'f5629d01-414d-4c70-8dc8-616478ddcc46');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
