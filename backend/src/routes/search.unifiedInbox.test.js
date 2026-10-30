import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));

import express from 'express';
import { openReplyFromMessage } from '../../../frontend/src/utils/composeFromMessage.js';
import searchRoutes from './search.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use('/api/search', searchRoutes);
  return app;
}

describe('GET /api/search unified account scope', () => {
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
  });

  it('searches only opted-in accounts when no account is selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['included']);
  });

  it('keeps an opted-out account searchable when explicitly selected', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/search?q=invoice&accountId=excluded`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['excluded']);
  });

  it.each([true, false])('projects stored reply metadata for compose (populated=%s)', async populated => {
    const row = {
      id: 'synthetic-message', account_id: 'included', from_email: 'sender@example.test',
      reply_to: populated ? [{ email: 'reply@example.test' }] : [],
      delivery_addresses: populated ? ['alias@example.test'] : [], thread_id: populated ? 'synthetic-thread' : null,
    };
    query.mockResolvedValueOnce({ rows: [{ id: 'included' }] }).mockResolvedValueOnce({ rows: [row] });
    const response = await fetch(`${base}/api/search?q=synthetic`);
    expect(response.status).toBe(200);
    const sql = query.mock.calls[1][0].split('FROM messages')[0];
    for (const field of ['reply_to', 'delivery_addresses', 'thread_id']) expect(sql).toContain(`m.${field}`);
    const { messages } = await response.json();
    expect(messages).toEqual([row]);
    let draft;
    await openReplyFromMessage(messages[0], {
      accounts: [{ id: 'included', email_address: 'owner@example.test', aliases: [{ id: 'alias', email: 'alias@example.test' }] }],
      openCompose: p => { draft = p; }, getMessageBody: async () => null,
    });
    expect(draft.to.map(a => a.email)).toEqual([populated ? 'reply@example.test' : 'sender@example.test']);
    expect(draft.aliasId).toBe(populated ? 'alias' : null);
    expect(draft.threadId).toBe(row.thread_id);
  });

});
