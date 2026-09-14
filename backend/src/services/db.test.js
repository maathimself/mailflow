import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('pg', () => ({ default: { Pool: class extends EventEmitter {} } }));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(), isEncrypted: vi.fn() }));
vi.mock('./performanceMetrics.js', () => ({ recordDb: vi.fn() }));
import { pool } from './db.js';
it('handles an idle connection failure instead of crashing the process', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
    expect(log).toHaveBeenCalledWith('Idle PostgreSQL connection error:', 'connection terminated');
  } finally { log.mockRestore(); }
});
