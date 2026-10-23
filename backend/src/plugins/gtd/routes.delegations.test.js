import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('./gtdDelegations.js', () => ({
  delegateMessages: vi.fn(),
  GtdDelegationError: class GtdDelegationError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
  },
}));

import express from 'express';
import { delegateMessages, GtdDelegationError } from './gtdDelegations.js';
import gtdRoutes from './routes.js';

const MESSAGE = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => vi.clearAllMocks());

const post = body => fetch(`${base}/api/gtd/delegations`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /api/gtd/delegations', () => {
  it.each([
    {},
    { messageIds: [] },
    { messageIds: ['bad'], contactId: null },
    { messageIds: [MESSAGE], contactId: 'bad' },
  ])('rejects malformed input before the service', async body => {
    expect((await post(body)).status).toBe(400);
    expect(delegateMessages).not.toHaveBeenCalled();
  });

  it('maps a non-owned contact to the same 404 as an absent contact', async () => {
    delegateMessages.mockRejectedValueOnce(new GtdDelegationError('contact_not_found', 404));
    const res = await post({ messageIds: [MESSAGE], contactId: CONTACT });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
  });

  it.each(['success', 'partial', 'failed'])('passes through a %s batch result', async status => {
    const result = { status, successCount: status === 'failed' ? 0 : 1, failureCount: status === 'success' ? 0 : 1, results: [] };
    delegateMessages.mockResolvedValueOnce(result);
    const res = await post({ messageIds: [MESSAGE], contactId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(delegateMessages).toHaveBeenCalledWith({ userId: 'user-1', messageIds: [MESSAGE], contactId: null });
  });
});
