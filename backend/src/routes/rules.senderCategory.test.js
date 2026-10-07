import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));

import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';

const MSG = 'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1';

describe('POST /api/rules/sender-category (#490)', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/rules', rulesRoutes);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => { query.mockReset(); });

  const post = body => fetch(`${base}/api/rules/sender-category`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const sqlCall = re => query.mock.calls.find(([sql]) => re.test(sql));

  // message lookup, existing-rule lookup, [count + insert | update], messages update
  function mockNewRule(fromEmail = 'Orders@Shop.example', updated = 3) {
    query
      .mockResolvedValueOnce({ rows: [{ from_email: fromEmail }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ lo: '0', hi: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'rule-new' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: updated });
  }

  it('saves "always for this sender" as an all-account rule and recategorizes that sender\'s inbox mail', async () => {
    mockNewRule();
    const res = await post({ messageId: MSG, scope: 'sender', category: 'automated', name: 'orders@shop.example → Automated' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ created: true, ruleId: 'rule-new', value: 'orders@shop.example', updated: 3 });
    const [, insertParams] = sqlCall(/INSERT INTO inbox_rules/);
    expect(insertParams[0]).toBe('user-1');
    expect(JSON.parse(insertParams[3])).toEqual([{ field: 'from', operator: 'equals', value: 'orders@shop.example' }]);
    expect(JSON.parse(insertParams[4])).toEqual([{ type: 'set_category', value: 'automated' }]);
    expect(insertParams[2]).toBe(4); // a sender rule runs after every existing rule
    const [updateSql, updateParams] = sqlCall(/UPDATE messages m SET category/);
    expect(updateSql).toMatch(/lower\(trim\(m\.from_email\)\) = \$3/);
    expect(updateSql).toMatch(/lower\(m\.folder\) = 'inbox'/);
    expect(updateParams).toEqual(['automated', 'user-1', 'orders@shop.example']);
  });

  it('matches the whole domain by its ending, without LIKE wildcards', async () => {
    mockNewRule('news_letter@shop.example');
    await post({ messageId: MSG, scope: 'domain', category: 'newsletter' });
    const [, insertParams] = sqlCall(/INSERT INTO inbox_rules/);
    expect(JSON.parse(insertParams[3])).toEqual([{ field: 'from', operator: 'ends_with', value: '@shop.example' }]);
    const [updateSql, updateParams] = sqlCall(/UPDATE messages m SET category/);
    expect(updateSql).toMatch(/right\(lower\(trim\(m\.from_email\)\), length\(\$3\)\) = \$3/);
    expect(updateSql).not.toMatch(/LIKE/);
    expect(updateParams[2]).toBe('@shop.example');
    expect(insertParams[2]).toBe(-1); // a domain rule runs before every existing rule
    expect(updateSql).toMatch(/NOT EXISTS/); // senders with their own rule keep their category
  });

  it('updates the rule it made before for the same sender instead of adding another', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ from_email: 'orders@shop.example' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'rule-old' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const body = await (await post({ messageId: MSG, scope: 'sender', category: 'promotion' })).json();
    expect(body).toMatchObject({ created: false, ruleId: 'rule-old' });
    expect(sqlCall(/INSERT INTO inbox_rules/)).toBeUndefined();
    const [, params] = sqlCall(/UPDATE inbox_rules SET actions/);
    expect(JSON.parse(params[0])).toEqual([{ type: 'set_category', value: 'promotion' }]);
    expect(params.slice(2)).toEqual(['rule-old', 'user-1']);
  });

  it('refuses bad input, someone else\'s message, and a message without an address', async () => {
    expect((await post({ messageId: 'nope', scope: 'sender', category: 'social' })).status).toBe(400);
    expect((await post({ messageId: MSG, scope: 'everyone', category: 'social' })).status).toBe(400);
    expect((await post({ messageId: MSG, scope: 'sender', category: 'spam' })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValueOnce({ rows: [] });
    expect((await post({ messageId: MSG, scope: 'sender', category: 'social' })).status).toBe(404);
    query.mockResolvedValueOnce({ rows: [{ from_email: 'undisclosed-recipients' }] });
    expect((await post({ messageId: MSG, scope: 'sender', category: 'social' })).status).toBe(422);
  });
});
