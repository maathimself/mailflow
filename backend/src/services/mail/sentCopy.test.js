import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  learnSentRecipients,
  persistSentCopy,
  resolveSentFolder,
  scheduleSentMetadataUpsert,
} from './sentCopy.js';

const account = {
  id: 'account-1',
  email_address: 'sender@example.com',
  folder_mappings: {},
};
const mailOptions = { messageId: '<message@example.com>' };
const meta = { messageId: '<message@example.com>', subject: 'Subject' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveSentFolder', () => {
  it('prefers the account folder mapping', async () => {
    const query = vi.fn();
    await expect(resolveSentFolder({ ...account, folder_mappings: { sent: 'Sent Items' } }, { query }))
      .resolves.toBe('Sent Items');
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back to the detected special-use folder', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ path: 'Sent' }] });
    await expect(resolveSentFolder(account, { query })).resolves.toBe('Sent');
    expect(query).toHaveBeenCalledWith(
      "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Sent' LIMIT 1",
      ['account-1'],
    );
  });
});

describe('persistSentCopy', () => {
  it('APPENDs exactly once, upserts metadata, and schedules the post-append sync', async () => {
    vi.useFakeTimers();
    const imapManager = {
      appendToSent: vi.fn().mockResolvedValue({ uid: 42 }),
      upsertSentMessageRecord: vi.fn().mockResolvedValue(undefined),
      syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
    };
    const runTransitionsForSentMessage = vi.fn().mockResolvedValue(undefined);

    await expect(persistSentCopy({
      account,
      sentFolder: 'Sent',
      rawMessage: Buffer.from('mime'),
      mailOptions,
      meta,
    }, { imapManager, runTransitionsForSentMessage })).resolves.toEqual({ sentCopySaved: true });

    expect(imapManager.appendToSent).toHaveBeenCalledTimes(1);
    expect(imapManager.upsertSentMessageRecord).toHaveBeenCalledWith(account, 'Sent', 42, meta);
    await vi.advanceTimersByTimeAsync(1000);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Sent');
    expect(runTransitionsForSentMessage).toHaveBeenCalledWith(imapManager, account, '<message@example.com>');
  });

  it('never retries a failed APPEND and schedules only the fallback sync', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const imapManager = {
      appendToSent: vi.fn().mockRejectedValue(new Error('append failed')),
      syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
    };

    await expect(persistSentCopy({
      account,
      sentFolder: 'Sent',
      rawMessage: Buffer.from('mime'),
      mailOptions,
      meta,
    }, { imapManager, runTransitionsForSentMessage: vi.fn() }))
      .resolves.toEqual({ sentCopySaved: false });

    expect(imapManager.appendToSent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(imapManager.appendToSent).toHaveBeenCalledTimes(1);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledTimes(1);
  });

  it('returns not-applicable and schedules two syncs for provider auto-save', async () => {
    vi.useFakeTimers();
    const imapManager = {
      findUidByMessageId: vi.fn().mockResolvedValue(null),
      syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
    };
    const runTransitionsForSentMessage = vi.fn().mockResolvedValue(undefined);

    await expect(persistSentCopy({
      account,
      sentFolder: 'Sent',
      rawMessage: null,
      mailOptions,
      meta: null,
    }, { imapManager, runTransitionsForSentMessage })).resolves.toEqual({ sentCopySaved: null });

    await vi.advanceTimersByTimeAsync(15000);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledTimes(2);
    expect(runTransitionsForSentMessage).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleSentMetadataUpsert', () => {
  it('searches until the sent message appears and then upserts once', async () => {
    const imapManager = {
      findUidByMessageId: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(7),
      upsertSentMessageRecord: vi.fn().mockResolvedValue(undefined),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    let scheduled;

    scheduleSentMetadataUpsert(account, 'Sent', mailOptions, meta, {
      imapManager,
      defer: fn => { scheduled = fn; },
      sleep,
    });
    await scheduled();

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(imapManager.findUidByMessageId).toHaveBeenCalledTimes(2);
    expect(imapManager.upsertSentMessageRecord).toHaveBeenCalledWith(account, 'Sent', 7, meta);
  });
});

describe('learnSentRecipients', () => {
  it('schedules contact learning without making the send await database work', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'book-1' }] })
      .mockResolvedValueOnce({ rows: [{ address_book_id: 'book-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    let scheduled;

    const result = learnSentRecipients({
      userId: 'user-1',
      recipients: ['Alice <ALICE@example.com>'],
    }, {
      query,
      defer: fn => { scheduled = fn; },
      randomUUID: () => 'contact-1',
      now: () => new Date('2026-07-28T00:00:00Z'),
    });

    expect(result).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    await scheduled();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][1]).toContain('alice@example.com');
  });
});
