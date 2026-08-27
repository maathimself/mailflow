import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_HTML = `<img src="/api/probe?src"><img src="https://cdn.example/safe.png">
  <img src="data:," srcset="/api/probe?srcset 1x">
  <table background="/api/probe?background"></table>
  <div style="color:red;background:url(/api/probe?inline)">content</div>
  <style>.x{background:url(/api/probe?block)}@import "/api/probe?import";</style>`;

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

function cachedMessage(preferences, bodyHtml = LEGACY_HTML) {
  return {
    id: MESSAGE_ID,
    account_id: '22222222-2222-4222-8222-222222222222',
    body_html: bodyHtml,
    body_text: 'content',
    attachments: [],
    snippet: 'content',
    from_email: 'sender@example.com',
    sender_email: 'sender@example.com',
    sender_name: 'Sender',
    preferences,
  };
}

describe('GET /api/mail/messages/:id/body cached resource safety', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it.each([
    ['remote-image blocking is disabled', { blockRemoteImages: false }, ''],
    ['the sender is whitelisted', { imageWhitelist: { addresses: ['sender@example.com'] } }, ''],
    ['the request explicitly loads remote images', {}, '?remoteImages=1'],
  ])('canonicalizes legacy cached resources when %s', async (_label, preferences, queryString) => {
    query.mockResolvedValueOnce({ rows: [cachedMessage(preferences)] });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body${queryString}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.html).not.toContain('/api/probe');
    expect(body.html).toContain('https://cdn.example/safe.png');
    expect(body.hasBlockedRemoteImages).toBe(false);

    const cacheWrite = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET body_html'));
    expect(cacheWrite).toBeDefined();
    expect(cacheWrite[1][0]).not.toContain('/api/probe');
    expect(cacheWrite[1][0]).toContain('https://cdn.example/safe.png');
    expect(cacheWrite[1][1]).toBe(MESSAGE_ID);
  });

  it('persists one fully canonical value after all legacy cache transforms', async () => {
    const legacyHtml = `<html><head><title>Legacy</title></head><body>
      <a href="example.com">link</a>
      <img src="https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.com/t.jpg&amp;w=200">
      <img src="/api/probe?src">
    </body></html>`;
    query.mockResolvedValueOnce({ rows: [cachedMessage({ blockRemoteImages: false }, legacyHtml)] });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.html).not.toContain('<head');
    expect(body.html).not.toContain('svcs.ebay.com/imageser');
    expect(body.html).not.toContain('/api/probe');
    expect(body.html).toContain('href="https://example.com"');
    expect(body.html).toContain('https://i.ebayimg.com/t.jpg');

    const cacheWrites = query.mock.calls.filter(([sql]) => sql.includes('UPDATE messages SET body_html'));
    expect(cacheWrites).toHaveLength(1);
    expect(cacheWrites[0][1][0]).toBe(body.html);
  });
});
