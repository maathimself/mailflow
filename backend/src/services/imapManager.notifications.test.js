// _notificationsEnabled reads the account's new-mail notification toggle fresh from the DB, so a
// change takes effect on the next arrival without a reconnect. It defaults to enabled on any error
// so a transient DB failure never silently drops notifications.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager } from './imapManager.js';
import { query } from './db.js';

let mgr;
beforeEach(() => {
  vi.clearAllMocks();
  mgr = new ImapManager(null);
});

describe('_notificationsEnabled', () => {
  it('is false when the account has the toggle off', async () => {
    query.mockResolvedValue({ rows: [{ notifications_enabled: false }] });
    expect(await mgr._notificationsEnabled('acct-1')).toBe(false);
  });

  it('is true when the toggle is on', async () => {
    query.mockResolvedValue({ rows: [{ notifications_enabled: true }] });
    expect(await mgr._notificationsEnabled('acct-1')).toBe(true);
  });

  it('defaults to true when the account row is missing', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await mgr._notificationsEnabled('acct-1')).toBe(true);
  });

  it('defaults to true on a DB error, never silently dropping notifications', async () => {
    query.mockRejectedValue(new Error('db down'));
    expect(await mgr._notificationsEnabled('acct-1')).toBe(true);
  });

  it('reads the flag fresh by account id', async () => {
    query.mockResolvedValue({ rows: [{ notifications_enabled: false }] });
    await mgr._notificationsEnabled('acct-42');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT notifications_enabled FROM email_accounts WHERE id = \$1/);
    expect(params).toEqual(['acct-42']);
  });
});
