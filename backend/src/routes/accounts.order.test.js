// #695: the sidebar order of a user's accounts is saved whole, through PATCH /api/accounts/order.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/accountOrder.js', () => ({ NEXT_ACCOUNT_SORT_ORDER: '0', setAccountOrder: vi.fn() }));

import express from 'express';
import accountRoutes from './accounts.js';
import { setAccountOrder } from '../services/accountOrder.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => setAccountOrder.mockReset());

const patch = body => fetch(`${base}/api/accounts/order`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('PATCH /api/accounts/order', () => {
  it('saves the order for the signed-in user', async () => {
    setAccountOrder.mockResolvedValue(true);
    const res = await patch({ ids: [B, A] });
    expect(res.status).toBe(200);
    expect(setAccountOrder).toHaveBeenCalledWith('user-1', [B, A]);
  });

  it('answers 409 when the ids are not exactly the user\'s accounts', async () => {
    setAccountOrder.mockResolvedValue(false);
    expect((await patch({ ids: [A] })).status).toBe(409);
  });

  it.each([[{}], [{ ids: [] }], [{ ids: 'x' }], [{ ids: [A, 'not-a-uuid'] }], [{ ids: [A, 5] }]])('refuses %j', async body => {
    expect((await patch(body)).status).toBe(400);
    expect(setAccountOrder).not.toHaveBeenCalled();
  });
});
