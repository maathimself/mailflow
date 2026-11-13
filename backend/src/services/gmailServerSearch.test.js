import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./imapManager.js', () => ({
  providerProfile: account => ((account.imap_host || '').includes('.gmail.com') ? { labelStore: true } : { labelStore: false }),
  withFreshClient: vi.fn(),
}));
import { gmailRawQuery, gmailServerMatches, GMAIL_SEARCH_MAX_RESULTS, _resetGmailSearchCache } from './gmailServerSearch.js';

const GMAIL = { id: 'g1', imap_host: 'imap.gmail.com' };
const OTHER = { id: 'o1', imap_host: 'mail.example.com' };

// A fake imapflow client over `messages` in All Mail: [{ uid, emailId, messageId, text }].
function fakeClient(messages, { gmailExt = true, allMail = '[Gmail]/All Mail' } = {}) {
  const client = {
    capabilities: new Set(gmailExt ? ['IMAP4rev1', 'X-GM-EXT-1'] : ['IMAP4rev1']),
    locks: [],
    searches: [],
    list: vi.fn(async () => [{ path: 'INBOX', specialUse: '\\Inbox' }, ...(allMail ? [{ path: allMail, specialUse: '\\All' }] : [])]),
    getMailboxLock: vi.fn(async (path, opts) => {
      const lock = { path, opts, released: false, release() { this.released = true; } };
      client.locks.push(lock);
      return lock;
    }),
    search: vi.fn(async ({ gmraw }) => {
      client.searches.push(gmraw);
      const words = [...gmraw.matchAll(/"([^"]*)"/g)].map(m => m[1].toLowerCase());
      return messages.filter(m => words.every(w => m.text.toLowerCase().includes(w))).map(m => m.uid);
    }),
    fetch: vi.fn(async function* (range) {
      const wanted = new Set(range.split(',').map(Number));
      for (const m of messages) if (wanted.has(m.uid)) yield { uid: m.uid, emailId: m.emailId, envelope: { messageId: m.messageId } };
    }),
  };
  return client;
}
const withClientFor = client => vi.fn(async (_account, fn) => fn(client));
const alerts = [
  { uid: 10, emailId: '1801', messageId: '<a@x>', text: 'Truck 5037 exited YARD' },
  { uid: 11, emailId: '1802', messageId: '<b@x>', text: 'Truck 5038 exited YARD' },
];

beforeEach(() => _resetGmailSearchCache());
afterEach(() => vi.useRealTimers());

describe('gmailRawQuery', () => {
  it('quotes each term so Gmail treats it as a word, not an operator', () => {
    expect(gmailRawQuery(['5037', 'from:boss', 'say "hi"\\'])).toBe('"5037" "from:boss" "say hi"');
    expect(gmailRawQuery(['""', ' '])).toBe('');
  });
});

describe('gmailServerMatches', () => {
  it('does nothing, and loads no account, without a Gmail account in scope', async () => {
    const loadAccounts = vi.fn();
    expect(await gmailServerMatches([OTHER], ['5037'], { loadAccounts })).toBeNull();
    expect(loadAccounts).not.toHaveBeenCalled();
  });

  it("returns the Gmail and Message-IDs of Gmail's matches in All Mail, read-only", async () => {
    const client = fakeClient(alerts);
    const loadAccounts = vi.fn(async ids => ids.map(id => ({ ...GMAIL, id })));
    const found = await gmailServerMatches([GMAIL, OTHER], ['5037'], { loadAccounts, withClient: withClientFor(client) });
    expect(loadAccounts).toHaveBeenCalledWith(['g1']);
    expect(found).toEqual({ accountIds: ['g1'], providerIds: ['1801'], messageIds: ['<a@x>'] });
    expect(client.searches).toEqual(['"5037"']);
    expect(client.locks).toEqual([expect.objectContaining({ path: '[Gmail]/All Mail', opts: { readOnly: true }, released: true })]);
  });

  it('returns null when Gmail finds nothing, or the server is not Gmail or has no All Mail', async () => {
    expect(await gmailServerMatches([GMAIL], ['9999'], { withClient: withClientFor(fakeClient(alerts)) })).toBeNull();
    _resetGmailSearchCache();
    expect(await gmailServerMatches([GMAIL], ['5037'], { withClient: withClientFor(fakeClient(alerts, { gmailExt: false })) })).toBeNull();
    _resetGmailSearchCache();
    expect(await gmailServerMatches([GMAIL], ['5037'], { withClient: withClientFor(fakeClient(alerts, { allMail: null })) })).toBeNull();
  });

  it('keeps the newest matches when there are more than it fetches', async () => {
    const many = Array.from({ length: GMAIL_SEARCH_MAX_RESULTS + 20 }, (_, i) => ({ uid: i + 1, emailId: `e${i + 1}`, messageId: `<${i + 1}@x>`, text: 'report' }));
    const found = await gmailServerMatches([GMAIL], ['report'], { withClient: withClientFor(fakeClient(many)) });
    expect(found.providerIds).toHaveLength(GMAIL_SEARCH_MAX_RESULTS);
    expect(found.providerIds[0]).toBe('e21');
  });

  it('gives up on a slow or failing Gmail and lets the local results stand', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slow = vi.fn(() => new Promise(() => {}));
    expect(await gmailServerMatches([GMAIL], ['5037'], { withClient: slow, timeoutMs: 20 })).toBeNull();
    _resetGmailSearchCache();
    const failing = vi.fn(async () => { throw new Error('NO [ALERT] Too many simultaneous connections'); });
    expect(await gmailServerMatches([GMAIL], ['5037'], { withClient: failing })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('answers a repeated query from its cache for a minute', async () => {
    const client = fakeClient(alerts);
    const withClient = withClientFor(client);
    let t = 1_000_000;
    const now = () => t;
    await gmailServerMatches([GMAIL], ['5037'], { withClient, now });
    await gmailServerMatches([GMAIL], ['5037'], { withClient, now });
    expect(client.search).toHaveBeenCalledTimes(1);
    t += 61_000;
    await gmailServerMatches([GMAIL], ['5037'], { withClient, now });
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('runs one search per account at a time and drops one a newer query replaced', async () => {
    const client = fakeClient(alerts);
    let release;
    const gate = new Promise(r => { release = r; });
    let active = 0;
    let most = 0;
    const withClient = vi.fn(async (_account, fn) => {
      active++; most = Math.max(most, active);
      if (withClient.mock.calls.length === 1) await gate;
      try { return await fn(client); } finally { active--; }
    });
    const first = gmailServerMatches([GMAIL], ['50'], { withClient });
    await vi.waitFor(() => expect(withClient).toHaveBeenCalledTimes(1)); // '50' is in flight
    const second = gmailServerMatches([GMAIL], ['503'], { withClient });
    const third = gmailServerMatches([GMAIL], ['5037'], { withClient });
    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(most).toBe(1);
    expect(b).toBeNull(); // replaced by '5037' while it waited
    expect(client.searches).toEqual(['"50"', '"5037"']);
    expect(a.providerIds).toEqual(['1801', '1802']);
    expect(c.providerIds).toEqual(['1801']);
  });

  it('runs only the newest of several searches that arrive before any starts', async () => {
    const client = fakeClient(alerts);
    const withClient = withClientFor(client);
    const results = await Promise.all(['50', '503', '5037'].map(t => gmailServerMatches([GMAIL], [t], { withClient })));
    expect(client.searches).toEqual(['"5037"']);
    expect(results.map(r => r?.providerIds ?? null)).toEqual([null, null, ['1801']]);
  });
});
