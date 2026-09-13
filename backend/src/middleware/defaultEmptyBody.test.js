import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { defaultEmptyBody } from './defaultEmptyBody.js';

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(defaultEmptyBody);
  app.post('/echo', (req, res) => {
    const { accountId } = req.body;
    res.json({ body: req.body, accountId: accountId ?? null });
  });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

describe('defaultEmptyBody', () => {
  it('gives a body-less POST an empty object so handlers can destructure it', async () => {
    const res = await fetch(`${baseUrl}/echo`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: {}, accountId: null });
  });

  it('gives a non-JSON body an empty object', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: {}, accountId: null });
  });

  it('keeps a parsed JSON body untouched', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'a1' }),
    });
    expect(await res.json()).toEqual({ body: { accountId: 'a1' }, accountId: 'a1' });
  });

  it('does not replace a body another parser already set', () => {
    const req = { body: 'raw' };
    let called = false;
    defaultEmptyBody(req, {}, () => { called = true; });
    expect(req.body).toBe('raw');
    expect(called).toBe(true);
  });
});
