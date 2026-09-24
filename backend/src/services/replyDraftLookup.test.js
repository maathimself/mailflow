import { describe, expect, it, vi } from 'vitest';
import { replyChainIds, draftFolderPaths, chooseReplyDraft, searchReplyDraftUids } from './replyDraftLookup.js';

const A = { id: 'a', account_id: 'account-a', message_id: '<a@example.test>', thread_id: 'shared' };
const sent = { id: 'sent', account_id: 'account-a', message_id: '<sent@example.test>', in_reply_to: A.message_id, thread_references: A.message_id, thread_id: 'shared' };
const draft = { id: 'draft', account_id: 'account-a', message_id: '<draft@example.test>', in_reply_to: sent.message_id, thread_references: `${A.message_id} ${sent.message_id}`, folder: 'Drafts', uid: '20', date: '2026-09-24T10:00:00Z', thread_id: 'shared' };

describe('reply-chain draft matching', () => {
  it('follows a reply through a Sent-folder connector', () => {
    expect([...replyChainIds(A, [A, sent, draft])]).toEqual([A.message_id, sent.message_id, draft.message_id]);
    expect(chooseReplyDraft(A, [A, sent], [draft], ['Drafts'])?.id).toBe('draft');
  });

  it('does not match an unrelated reply in a subject-merged thread', () => {
    const other = { ...A, id: 'other', message_id: '<other@example.test>' };
    const unrelated = { ...draft, id: 'unrelated', message_id: '<unrelated@example.test>', in_reply_to: other.message_id, thread_references: other.message_id };
    expect(chooseReplyDraft(A, [A, other], [unrelated], ['Drafts'])).toBeNull();
  });

  it('does not cross accounts or use a message without an RFC Message-ID', () => {
    expect(chooseReplyDraft(A, [A], [{ ...draft, account_id: 'account-b', in_reply_to: A.message_id }], ['Drafts'])).toBeNull();
    expect(chooseReplyDraft({ ...A, message_id: null }, [sent], [draft], ['Drafts'])).toBeNull();
  });

  it('matches a reply draft without its own Message-ID through its reply header', () => {
    const external = { ...draft, message_id: null, in_reply_to: A.message_id, thread_references: null };
    expect(chooseReplyDraft(A, [A], [external], ['Drafts'])?.id).toBe('draft');
  });

  it('keeps the newest eligible live draft and ignores other folders', () => {
    const older = { ...draft, id: 'older', uid: '18', date: '2026-09-23T10:00:00Z' };
    const wrongFolder = { ...draft, id: 'wrong-folder', folder: 'Draft Projects', date: '2026-09-25T10:00:00Z' };
    expect(chooseReplyDraft(A, [A, sent], [older, wrongFolder, draft], ['Drafts'])?.id).toBe('draft');
  });
});

describe('real Drafts folder resolution', () => {
  it('unions selectable mapping and server-designated Drafts, excluding lookalike names', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [{ path: 'Custom' }, { path: '[Gmail]/Drafts' }] });
    expect(await draftFolderPaths('account-a', { drafts: 'Custom' }, queryFn)).toEqual(['Custom', '[Gmail]/Drafts']);
    expect(queryFn.mock.calls[0][0]).toContain('special_use');
    expect(queryFn.mock.calls[0][0]).not.toContain("LIKE '%draft%'");
  });
});

describe('live IMAP reply search', () => {
  it('searches both reply headers in every real Drafts folder and keeps old UIDs', async () => {
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValueOnce([1, 201]).mockResolvedValueOnce([4]),
    };
    const found = await searchReplyDraftUids(client, ['Custom', 'ServerDrafts'], ['<a@example.test>', '<b@example.test>']);
    expect(found).toEqual([{ folder: 'Custom', uid: 1 }, { folder: 'Custom', uid: 201 }, { folder: 'ServerDrafts', uid: 4 }]);
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(client.search.mock.calls[0][0])).toContain('In-Reply-To');
    expect(JSON.stringify(client.search.mock.calls[0][0])).toContain('References');
    expect(client.getMailboxLock.mock.results[0].value).toBeDefined();
  });

  it('does not treat an incomplete SEARCH as an empty Drafts folder', async () => {
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }), search: vi.fn().mockResolvedValue(undefined) };
    await expect(searchReplyDraftUids(client, ['Drafts'], ['<a@example.test>'])).rejects.toThrow('Incomplete draft search');
  });
});
