import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(v => `enc:v1:${v}`), decrypt: vi.fn(v => v?.replace(/^enc:v1:/, '')), isEncrypted: vi.fn(v => v?.startsWith('enc:v1:')) }));

import { query } from './db.js';
import { encrypt } from './encryption.js';
import { getJevStatus, saveJevKey, removeJevKey, getJevKey, evaluateJev } from './jev.js';

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()); });

describe('per-user Jev credential', () => {
  it('saves encrypted only, replaces by user/provider, and redacts status', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ config: { apiKey: 'enc:v1:secret' } }] });
    await saveJevKey('user-a', 'secret');
    expect(query.mock.calls[0][1]).toEqual(['user-a', { apiKey: 'enc:v1:secret' }]);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (user_id, provider)');
    const status = await getJevStatus('user-a');
    expect(status).toEqual({ configured: true });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('fails closed when encryption cannot run and never writes plaintext', async () => {
    encrypt.mockImplementationOnce(() => { throw new Error('missing encryption'); });
    await expect(saveJevKey('user-a', 'secret')).rejects.toThrow('missing encryption');
    expect(query).not.toHaveBeenCalled();
  });

  it('loads only the owning user key and removal has no fallback', async () => {
    query.mockResolvedValueOnce({ rows: [{ config: { apiKey: 'enc:v1:secret' } }] }).mockResolvedValueOnce({ rows: [] });
    expect(await getJevKey('user-a')).toBe('secret');
    await removeJevKey('user-a');
    expect(query.mock.calls[1][1]).toEqual(['user-a']);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getJevKey('user-a')).toBeNull();
  });

  it('rejects malformed or plaintext stored credentials', async () => {
    query.mockResolvedValueOnce({ rows: [{ config: { apiKey: 'enc:garbage' } }] })
      .mockResolvedValueOnce({ rows: [{ config: { apiKey: 'plaintext' } }] });
    expect(await getJevKey('user-a')).toBeNull();
    expect(await getJevKey('user-a')).toBeNull();
  });
});

describe('TypeSafe client', () => {
  it('uses fixed endpoint, bearer key, pinned model and bounded message content', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { match: { type: 'noul', noul: 0.82 } } }) });
    expect(await evaluateJev('secret', 'Is this an invoice?', { fromEmail: 'a@example.org', subject: 'Receipt', body: 'x'.repeat(100_000), attachments: ['attachment-secret'], apiKey: 'credential-secret' })).toEqual({ probability: 0.82, available: true });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(options.body).model).toBe('jev-1.13.0');
    expect(JSON.parse(options.body).questions.match).toEqual({ type: 'noul', instructions: 'Is this an invoice?' });
    expect(Buffer.byteLength(options.body)).toBeLessThanOrEqual(16_384);
    expect(options.body).not.toContain('attachment-secret');
    expect(options.body).not.toContain('credential-secret');
    expect(options.signal).toBeDefined();
  });

  it.each([null, -0.1, 1.1, '0.8', Infinity])('rejects invalid noul probability %s', async probability => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ answers: { match: { type: 'noul', noul: probability } } }) });
    expect(await evaluateJev('secret', 'Question?', { body: 'hello' })).toEqual({ probability: null, available: false });
  });

  it('treats timeout and provider errors as unavailable', async () => {
    fetch.mockRejectedValue(new Error('timeout'));
    expect(await evaluateJev('secret', 'Question?', { body: 'hello' })).toEqual({ probability: null, available: false });
  });
});
