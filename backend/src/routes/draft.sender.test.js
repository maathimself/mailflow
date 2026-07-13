import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/senderAuthorization.js', () => ({ authorizeSender: vi.fn() }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToFolder: vi.fn(),
    permanentDeleteMessage: vi.fn(),
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'u1' };
    next();
  },
}));

import express from 'express';
import { query } from '../services/db.js';
import { authorizeSender } from '../services/senderAuthorization.js';
import { imapManager } from '../index.js';
import draftRoutes from './draft.js';

const sender = { accountId: 'a1', aliasId: 'alias-1', fromEmail: null };
const account = {
  id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
  folder_mappings: { drafts: 'Drafts' },
};
const authorizedSender = {
  account,
  fromName: 'Exact Alias',
  fromEmail: 'alias@example.com',
  fromReplyTo: 'reply@example.com',
  fromSignature: '<p>Alias signature</p>',
};

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/mail', draftRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  authorizeSender.mockReset();
  imapManager.appendToFolder.mockReset();
  imapManager.permanentDeleteMessage.mockReset();
  authorizeSender.mockResolvedValue(authorizedSender);
  imapManager.appendToFolder.mockResolvedValue({ uid: 42 });
  query.mockResolvedValue({ rows: [] });
});

const postDraft = body => fetch(`${base}/mail/draft`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /mail/draft explicit sender', () => {
  it('authorizes the exact request sender and generates MIME from the trusted identity', async () => {
    const res = await postDraft({ sender, to: ['to@example.com'], subject: 'Draft', body: 'Hello' });

    expect(res.status).toBe(200);
    expect(authorizeSender).toHaveBeenCalledWith({ userId: 'u1', sender });
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString('utf8');
    expect(raw).toContain('From: Exact Alias <alias@example.com>');
    expect(raw).toContain('Reply-To: reply@example.com');
  });

  it('generates an address-only From header for a blank Fastmail identity name', async () => {
    authorizeSender.mockResolvedValue({
      ...authorizedSender,
      fromName: '',
      fromEmail: 'unnamed@fastmail.example',
    });

    const res = await postDraft({ sender, to: ['to@example.com'], subject: 'Draft', body: 'Hello' });

    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString('utf8');
    expect(raw).toContain('From: unnamed@fastmail.example');
    expect(raw).not.toContain('From: Account Owner');
  });

  it('applies complete Fastmail identity Reply-To and Bcc routing to draft MIME', async () => {
    authorizeSender.mockResolvedValue({
      ...authorizedSender,
      fromReplyTo: [
        { name: 'Support', address: 'support@example.com' },
        'archive@example.com',
      ],
      fromBcc: [
        { name: 'Compliance', address: 'compliance@example.com' },
        'journal@example.com',
      ],
    });

    const res = await postDraft({
      sender,
      to: ['to@example.com'],
      bcc: ['visible-bcc@example.com'],
      subject: 'Draft',
      body: 'Hello',
    });

    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2]
      .toString('utf8')
      .replace(/\r?\n[ \t]+/g, ' ');
    expect(raw).toContain('Reply-To: Support <support@example.com>, archive@example.com');
    expect(raw).toContain(
      'Bcc: visible-bcc@example.com, Compliance <compliance@example.com>, journal@example.com',
    );
  });

  it('returns SENDER_UNAVAILABLE before IMAP side effects', async () => {
    authorizeSender.mockRejectedValue(Object.assign(new Error('Sender unavailable'), {
      status: 422, code: 'SENDER_UNAVAILABLE',
    }));

    const res = await postDraft({ sender, to: ['to@example.com'], body: 'Hello' });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Sender unavailable', code: 'SENDER_UNAVAILABLE' });
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('does not expose unexpected sender-authorization failures', async () => {
    const privateDetail = 'private-database-detail-9137';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    authorizeSender.mockRejectedValue(new Error(privateDetail));

    const res = await postDraft({ sender, to: ['to@example.com'], body: 'Hello' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to authorize sender' });
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain(privateDetail);
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('preserves primary-sender body, signature, and inline-image MIME rendering', async () => {
    authorizeSender.mockResolvedValue({
      ...authorizedSender,
      fromName: 'Account Owner',
      fromEmail: 'owner@example.com',
      fromReplyTo: null,
      fromSignature: '<p>Account signature</p>',
    });
    const primary = { accountId: 'a1', aliasId: null, fromEmail: null };
    const pixel = 'data:image/png;base64,iVBORw0KGgo=';

    const res = await postDraft({
      sender: primary,
      to: ['to@example.com'],
      subject: 'MIME regression',
      body: `<p>Hello body</p><img src="${pixel}">`,
      bodyIsHtml: true,
      quotedBody: '\nQuoted text',
      quotedBodyHtml: '<blockquote>Quoted HTML</blockquote>',
    });

    expect(res.status).toBe(200);
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString('utf8');
    expect(raw).toContain('From: Account Owner <owner@example.com>');
    expect(raw).toContain('Hello body');
    expect(raw).toContain('Account signature');
    expect(raw).toContain('<blockquote>Quoted =');
    expect(raw).toContain('HTML</blockquote>');
    expect(raw).toContain('Content-ID: <img-');
    expect(raw).not.toContain('data:image/png;base64');
  });
});
