import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));
import { query } from './db.js';
import { kv } from './kvStore.js';
import { safeFetch } from './safeFetch.js';
import { decrypt, isEncrypted } from './encryption.js';
import { getWebhook, removeWebhook, saveWebhook, saveWebhookAdminSettings, notifyWebhook } from './webhooks.js';

// Explicit opt-in databases only. A unique schema and random user IDs isolate this suite;
// cleanup removes only that schema.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('webhook persistence and shared rate limit', () => {
  let database, userId, oldKey;
  const schema = `webhook_test_${randomUUID().replaceAll('-', '')}`;
  const stored = async () => (await database.query('SELECT * FROM notification_webhooks WHERE user_id = $1', [userId])).rows[0];
  const send = () => notifyWebhook({ userId, accountName: 'Work', count: 1, latest: { subject: 'Mail' } });
  beforeAll(async () => {
    oldKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
    database = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await database.query(`CREATE SCHEMA ${schema}`);
    await database.query('CREATE TABLE users (id uuid PRIMARY KEY, preferences jsonb DEFAULT \'{}\'::jsonb); CREATE TABLE system_settings (key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT NOW())');
    const migration = await readFile(new URL('../../migrations/0077_notification_webhooks.sql', import.meta.url), 'utf8');
    await database.query(migration);
    // Idempotence matters when startup rechecks migration files.
    await database.query(migration);
    query.mockImplementation((sql, params) => database.query(sql, params));
    await database.query(await readFile(new URL('../../migrations/0076_sessions_and_kv_store.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    if (database) {
      await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await database.end();
    }
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = oldKey;
  });
  beforeEach(async () => {
    userId = randomUUID();
    await database.query('INSERT INTO users (id) VALUES ($1)', [userId]);
    await saveWebhookAdminSettings({ enabled: true, allowedOrigins: [] });
    await saveWebhook(userId, { enabled: true, format: 'ntfy', url: 'https://notify.example/secret-topic', token: 'secret-token' });
    safeFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
  });
  it('encrypts persisted secrets, retains omissions, clears tokens, and returns no credentials', async () => {
    const row = await stored();
    expect(isEncrypted(row.url)).toBe(true);
    expect(isEncrypted(row.token)).toBe(true);
    expect(decrypt(row.url)).toBe('https://notify.example/secret-topic');
    expect(decrypt(row.token)).toBe('secret-token');
    await saveWebhook(userId, { includeSender: true });
    expect((await stored()).url).toBe(row.url);
    expect((await stored()).token).toBe(row.token);
    expect(JSON.stringify(await getWebhook(userId))).not.toMatch(/secret-topic|secret-token|enc:v1/);
    await saveWebhook(userId, { token: '' });
    expect((await stored()).token).toBeNull();
  });
  it('removes saved credentials and stops further delivery', async () => {
    await removeWebhook(userId);
    expect(await stored()).toBeUndefined();
    expect(await getWebhook(userId)).toMatchObject({ enabled: false, urlConfigured: false, tokenConfigured: false });
    expect(await send()).toEqual({ skipped: 'disabled' });
    expect(safeFetch).not.toHaveBeenCalled();
    await removeWebhook(userId);
  });
  it('keeps tokens within one origin and clears them for a different host, scheme or port', async () => {
    await saveWebhook(userId, { url: 'https://NOTIFY.example:443/another-topic' });
    expect(decrypt((await stored()).token)).toBe('secret-token');
    for (const url of ['https://other.example/topic', 'https://other.example:8443/topic', 'http://other.example:8443/topic']) {
      await saveWebhookAdminSettings({ enabled: true, allowedOrigins: [new URL(url).origin] });
      await saveWebhook(userId, { token: 'saved-token' });
      await saveWebhook(userId, { url });
      expect((await stored()).token).toBeNull();
      await send();
      expect(safeFetch.mock.calls.at(-1)[1].headers.Authorization).toBeUndefined();
    }
  });
  it('allows an explicitly supplied replacement token for a new origin', async () => {
    await saveWebhook(userId, { url: 'https://other.example/topic', token: 'replacement-token' });
    expect(decrypt((await stored()).token)).toBe('replacement-token');
  });
  it('disables after five failures, skips while disabled, and explicitly re-enables', async () => {
    safeFetch.mockRejectedValue(new Error('secret URL'));
    for (let i = 1; i <= 5; i++) {
      expect(await send()).toEqual({ error: 'Delivery failed' });
      expect((await stored()).failures).toBe(i);
    }
    expect((await stored()).enabled).toBe(false);
    expect(await send()).toEqual({ skipped: 'disabled' });
    expect(safeFetch).toHaveBeenCalledTimes(5);
    await saveWebhook(userId, { enabled: true });
    expect((await stored()).enabled).toBe(true);
    expect((await stored()).failures).toBe(0);
    expect((await stored()).last_error).toBeNull();
  });
  it('success resets consecutive failures', async () => {
    safeFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await send();
    expect((await stored()).failures).toBe(1);
    await send();
    expect((await stored()).failures).toBe(0);
    expect((await stored()).last_error).toBeNull();
  });
  it('does not apply stale completion to a changed endpoint', async () => {
    let rejectDelivery, started;
    const atFetch = new Promise(resolve => { started = resolve; });
    safeFetch.mockImplementationOnce(() => { started(); return new Promise((_resolve, reject) => { rejectDelivery = reject; }); });
    const pending = send();
    await atFetch;
    const revision = (await stored()).revision;
    await saveWebhook(userId, { enabled: true, url: 'https://notify.example/new-topic' });
    expect((await stored()).revision).not.toBe(revision);
    rejectDelivery(new Error('old request failed'));
    await pending;
    expect((await stored()).failures).toBe(0);
    expect((await stored()).enabled).toBe(true);
  });
  it('atomically counts concurrent failures without losing increments', async () => {
    const releases = [];
    let allStarted;
    const started = new Promise(resolve => { allStarted = resolve; });
    safeFetch.mockImplementation(() => new Promise((_resolve, reject) => {
      releases.push(reject);
      if (releases.length === 5) allStarted();
    }));
    const pending = Array.from({ length: 5 }, () => send());
    await started;
    releases.forEach(reject => reject(new Error('failed')));
    await Promise.all(pending);
    expect((await stored()).failures).toBe(5);
    expect((await stored()).enabled).toBe(false);
  });
  it('preserves the disable reason when an earlier request succeeds late', async () => {
    let complete, started;
    const atFetch = new Promise(resolve => { started = resolve; });
    safeFetch.mockImplementationOnce(() => { started(); return new Promise(resolve => { complete = resolve; }); });
    const late = send();
    await atFetch;
    safeFetch.mockResolvedValue({ ok: false, status: 503 });
    for (let i = 0; i < 5; i++) await send();
    expect((await stored()).enabled).toBe(false);
    complete({ ok: true, status: 200 });
    await late;
    expect((await stored()).failures).toBe(5);
    expect((await stored()).last_error).toBe('Endpoint returned HTTP 503');
  });
  it('admits only ten concurrent attempts and does not count rate skips as failures', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => send()));
    expect(results.filter(result => result.sent)).toHaveLength(10);
    expect(results.filter(result => result.skipped === 'rate_limit')).toHaveLength(5);
    expect(safeFetch).toHaveBeenCalledTimes(10);
    expect((await stored()).failures).toBe(0);
    expect(await kv.get(`rl:webhook:rate:${userId}`)).toBe('15');
    const ttl = await kv.pTTL(`rl:webhook:rate:${userId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60000);
  });
  it('starts a new fixed window after expiry', async () => {
    const key = `rl:webhook:rate:${userId}`;
    await database.query("INSERT INTO kv_store (key, value, expires_at) VALUES ($1, '10', now() - interval '1 second')", [key]);
    expect(await send()).toEqual({ sent: true });
    expect(await kv.get(key)).toBe('1');
  });
  it('uses the limiter memory fallback when the key store fails', async () => {
    const incr = vi.spyOn(kv, 'incr').mockRejectedValue(new Error('database unavailable'));
    try {
      const results = await Promise.all(Array.from({ length: 12 }, () => send()));
      expect(results.filter(result => result.sent)).toHaveLength(10);
      expect(results.filter(result => result.skipped === 'rate_limit')).toHaveLength(2);
      expect((await stored()).failures).toBe(0);
    } finally { incr.mockRestore(); }
  });
  it('uses the saved user language and picks up changes without restarting', async () => {
    await database.query("UPDATE users SET preferences = $1 WHERE id = $2", [JSON.stringify({ language: 'zhCN' }), userId]);
    await saveWebhook(userId, { includeSubject: true });
    await send();
    let request = safeFetch.mock.calls[0][1];
    expect(Buffer.from(request.headers.Title.slice(10, -2), 'base64').toString()).toBe('Work · 1 封新邮件');
    expect(request.body).toBe('Mail');
    await database.query("UPDATE users SET preferences = $1 WHERE id = $2", [JSON.stringify({ language: 'en' }), userId]);
    await send();
    request = safeFetch.mock.calls[1][1];
    expect(Buffer.from(request.headers.Title.slice(10, -2), 'base64').toString()).toBe('Work · 1 new message');
  });

});
