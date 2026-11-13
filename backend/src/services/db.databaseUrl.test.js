import { afterEach, expect, it, vi } from 'vitest';

const poolConfigs = vi.hoisted(() => []);
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(config) { poolConfigs.push(config); }
      on() {}
    },
  },
}));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(), isEncrypted: vi.fn() }));
vi.mock('./performanceMetrics.js', () => ({ recordDb: vi.fn() }));

async function poolConfigFor(env) {
  Object.entries(env).forEach(([key, value]) => vi.stubEnv(key, value));
  vi.resetModules();
  await import('./db.js');
  return poolConfigs.at(-1);
}

afterEach(() => vi.unstubAllEnvs());

const dbVars = { DB_HOST: 'db.internal', DB_PORT: '6543', DB_NAME: 'other', DB_USER: 'other', DB_PASSWORD: 'secret' };

it('connects with DATABASE_URL and ignores every DB_* variable', async () => {
  const config = await poolConfigFor({ ...dbVars, DATABASE_URL: 'postgres://u:p@external:5433/mail' });
  expect(config.connectionString).toBe('postgres://u:p@external:5433/mail');
  ['host', 'port', 'database', 'user', 'password'].forEach(key => expect(config).not.toHaveProperty(key));
  expect(config.options).toBe('-c statement_timeout=30000');
});

it('uses the DB_* variables when DATABASE_URL is empty', async () => {
  const config = await poolConfigFor({ ...dbVars, DATABASE_URL: '' });
  expect(config).not.toHaveProperty('connectionString');
  expect(config).toMatchObject({ host: 'db.internal', port: 6543, database: 'other', user: 'other', password: 'secret' });
});
