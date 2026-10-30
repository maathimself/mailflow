import { describe, expect, it } from 'vitest';
import { API_TOKEN_ROUTES, matchApiTokenRoute } from './apiTokenAllowlist.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const concrete = path => path.replaceAll(':uuid', ID);

describe('the API token allowlist matcher', () => {
  it('matches every entry, with its scope, and a query string after it', () => {
    for (const route of API_TOKEN_ROUTES) {
      expect(matchApiTokenRoute(route.method, concrete(route.path)), `${route.method} ${route.path}`).toBe(route);
      expect(matchApiTokenRoute(route.method, `${concrete(route.path)}?a=1&b=%2F`)).toBe(route);
    }
  });

  it('takes upper-case hex in a UUID, as the routes do', () => {
    expect(matchApiTokenRoute('GET', `/api/mail/messages/${ID.toUpperCase()}/body`)?.path).toBe('/api/mail/messages/:uuid/body');
  });

  it('lists the routes #617 promises and nothing more', () => {
    expect(API_TOKEN_ROUTES.map(r => `${r.method} ${r.path} ${r.scope}${r.guard ? ` ${r.guard}` : ''}`).sort()).toEqual([
      'GET /api/accounts read',
      'GET /api/accounts/:uuid/folders read',
      'GET /api/api-tokens/self null',
      'GET /api/health null',
      'GET /api/mail/category-counts read',
      'GET /api/mail/messages read',
      'GET /api/mail/messages/:uuid read',
      'GET /api/mail/messages/:uuid/body read',
      'GET /api/mail/resolve-message read',
      'GET /api/mail/thread read',
      'GET /api/mail/unread-counts read',
      'GET /api/search read',
      'GET /api/search/contacts read',
      'GET /api/version null',
      'PATCH /api/mail/messages/:uuid/category organize',
      'PATCH /api/mail/messages/:uuid/snooze organize',
      'POST /api/mail/draft draft draft',
      'POST /api/mail/messages/:uuid/snooze organize snooze',
      'POST /api/mail/messages/:uuid/unsnooze organize',
      'POST /api/mail/messages/bulk-archive organize bulkArchive',
      'POST /api/mail/messages/bulk-move organize bulkMove',
      'POST /api/mail/messages/bulk-read organize',
      'POST /api/mail/messages/bulk-star organize',
      'POST /api/mail/reply-drafts/indicators draft',
    ]);
  });

  it('refuses variants Express would still route: trailing slash, other case, HEAD and OPTIONS', () => {
    for (const [method, path] of [
      ['GET', '/api/mail/messages/'],
      ['GET', '/api/accounts/'],
      ['GET', '/api/search/contacts/'],
      ['GET', '/API/mail/messages'],
      ['GET', '/api/Mail/messages'],
      ['GET', '/api/mail/Messages'],
      ['POST', '/api/mail/messages/BULK-READ'],
      ['HEAD', '/api/mail/messages'],
      ['HEAD', '/api/health'],
      ['OPTIONS', '/api/mail/messages'],
      ['get', '/api/mail/messages'],
      ['POST', '/api/mail/messages'],
      ['DELETE', `/api/mail/messages/${ID}`],
      ['PATCH', `/api/mail/messages/${ID}/read`],
      ['PATCH', `/api/mail/messages/${ID}/star`],
    ]) {
      expect(matchApiTokenRoute(method, path), `${method} ${path}`).toBe(null);
    }
  });

  it('refuses double slashes, encoded slashes and characters, and dot segments', () => {
    for (const path of [
      '//api/mail/messages',
      '/api//mail/messages',
      '/api/mail//messages',
      `/api/mail/messages//${ID}`,
      '/api%2Fmail/messages',
      '/api/mail%2Fmessages',
      `/api/mail/messages/${ID}%2Fbody`,
      `/api/mail/messages/${ID.replace('-', '%2D')}`,
      '/api/mail/%6Dessages',
      '/api/./mail/messages',
      '/api/mail/./messages',
      '/api/mail/../mail/messages',
      '/api/admin/../mail/messages',
      `/api/mail/messages/${ID}/..`,
      `/api/mail/messages/${ID}/.`,
      '/api/mail/messages/.',
      '/api/search/../admin/settings',
      'http://mail.example.com/api/mail/messages',
      'api/mail/messages',
      '',
    ]) {
      expect(matchApiTokenRoute('GET', path), path).toBe(null);
    }
  });

  it('refuses extra segments and other routes under the same prefixes', () => {
    for (const [method, path] of [
      ['GET', `/api/mail/messages/${ID}/raw.eml`],
      ['GET', `/api/mail/messages/${ID}/attachments/1`],
      ['GET', `/api/mail/messages/${ID}/attachments.zip`],
      ['GET', `/api/mail/messages/${ID}/headers`],
      ['GET', `/api/mail/messages/${ID}/image`],
      ['GET', `/api/mail/messages/${ID}/bcc`],
      ['GET', `/api/mail/messages/${ID}/reply-draft`],
      ['GET', `/api/mail/messages/${ID}/body/extra`],
      ['GET', '/api/mail/thread/%3Cid%40example.com%3E'],
      ['GET', '/api/mail/thread/x'],
      ['GET', `/api/accounts/${ID}`],
      ['GET', `/api/accounts/${ID}/aliases`],
      ['GET', `/api/accounts/${ID}/folders/x`],
      ['POST', '/api/mail/send'],
      ['POST', '/api/mail/draft/1'],
      ['DELETE', '/api/mail/draft/1'],
      ['POST', '/api/mail/messages/bulk-delete'],
      ['POST', '/api/mail/mark-all-read'],
      ['POST', `/api/mail/messages/${ID}/copy`],
      ['GET', '/api/api-tokens'],
      ['POST', '/api/api-tokens'],
      ['DELETE', `/api/api-tokens/${ID}`],
      ['GET', '/api/api-tokens/self/x'],
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/admin/settings'],
      ['GET', '/api/update'],
      ['GET', '/api/searchx'],
      ['GET', '/api/search/contactsx'],
    ]) {
      expect(matchApiTokenRoute(method, path), `${method} ${path}`).toBe(null);
    }
  });

  it('takes only a UUID where the entry says :uuid, so literal siblings never pass for one', () => {
    for (const id of ['bulk-read', 'bulk-move', 'mailbox-usage', '1', `${ID}x`, ID.slice(1), ID.replaceAll('-', ''), `{${ID}}`, ' ' + ID]) {
      expect(matchApiTokenRoute('GET', `/api/mail/messages/${id}`), id).toBe(null);
      expect(matchApiTokenRoute('GET', `/api/mail/messages/${id}/body`), id).toBe(null);
      expect(matchApiTokenRoute('GET', `/api/accounts/${id}/folders`), id).toBe(null);
      expect(matchApiTokenRoute('POST', `/api/mail/messages/${id}/snooze`), id).toBe(null);
    }
  });

  it('refuses what is not a method and a path', () => {
    expect(matchApiTokenRoute(undefined, '/api/health')).toBe(null);
    expect(matchApiTokenRoute('GET', undefined)).toBe(null);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(API_TOKEN_ROUTES)).toBe(true);
    expect(API_TOKEN_ROUTES.every(Object.isFrozen)).toBe(true);
  });
});
