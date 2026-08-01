import { describe, expect, it, vi } from 'vitest';
import {
  buildRawDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  saveDraft,
} from './draftService.js';
import { sendMessage } from './sendService.js';

const account = {
  id: 'account-1',
  email_address: 'sender@example.com',
  name: 'Sender',
  sender_name: null,
  signature: null,
  folder_mappings: {},
};

function draftInput(overrides = {}) {
  return {
    userId: 'user-1',
    account,
    to: ['Recipient <recipient@example.com>'],
    cc: [],
    bcc: [],
    subject: 'Draft subject',
    body: 'Draft body',
    bodyIsHtml: false,
    ...overrides,
  };
}

function buildDeps(overrides = {}) {
  return {
    query: vi.fn(),
    imapManager: {},
    resolveFromIdentity: vi.fn().mockResolvedValue({
      fromName: 'Sender',
      fromEmail: 'sender@example.com',
      fromReplyTo: 'reply@example.com',
      signature: null,
      aliasId: null,
    }),
    embedInlineDataImages: vi.fn(html => ({ html, attachments: [] })),
    buildMailOptions: vi.fn(options => options),
    renderRaw: vi.fn().mockResolvedValue(Buffer.from('raw draft')),
    randomBytes: vi.fn(() => Buffer.alloc(16, 3)),
    ...overrides,
  };
}

describe('buildRawDraft', () => {
  it('uses the already-scoped account and carries reply, attachment, and priority fields into MIME', async () => {
    const deps = buildDeps();

    const result = await buildRawDraft(draftInput({
      aliasId: 'alias-1',
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
      replyTo: 'explicit-reply@example.com',
      priority: 'high',
      attachments: [{
        filename: 'draft.txt',
        content: Buffer.from('draft attachment').toString('base64'),
        contentType: 'text/plain',
      }],
    }), deps);

    expect(deps.resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasId: 'alias-1', aliasEmail: undefined },
      deps,
    );
    expect(deps.query).not.toHaveBeenCalled();
    expect(deps.buildMailOptions).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: 'explicit-reply@example.com',
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
      priority: 'high',
      attachments: [expect.objectContaining({
        filename: 'draft.txt',
        content: Buffer.from('draft attachment'),
      })],
    }));
    expect(result).toMatchObject({
      rawMessage: Buffer.from('raw draft'),
      account,
      meta: {
        fromName: 'Sender',
        fromEmail: 'sender@example.com',
        bodyHtml: expect.stringContaining('Draft body'),
        bodyText: expect.stringContaining('Draft body'),
        inReplyTo: '<parent@example.com>',
        references: '<root@example.com> <parent@example.com>',
      },
    });
    expect(result.meta.messageId).toMatch(/^<03030303.+@example\.com>$/);
  });
});

describe('saveDraft', () => {
  it('persists reply threading metadata unchanged so a reopened draft can send in the same thread', async () => {
    const inReplyTo = '<parent@example.com>';
    const references = '<root@example.com> <parent@example.com>';
    let persistedRow;
    const imapManager = {
      appendToFolder: vi.fn().mockResolvedValue({ uid: 5 }),
      upsertDraftMessageRecord: vi.fn(async (_account, _folder, uid, meta) => {
        persistedRow = {
          uid,
          in_reply_to: meta.inReplyTo,
          thread_references: meta.references,
        };
      }),
      permanentDeleteMessage: vi.fn(),
    };
    const query = vi.fn(async (sql) => {
      if (sql.includes("special_use = '\\Drafts'")) return { rows: [{ path: 'Drafts' }] };
      if (sql.includes('SELECT * FROM messages')) return { rows: [persistedRow] };
      return { rows: [] };
    });
    const deps = buildDeps({ imapManager, query });

    await saveDraft(draftInput({ inReplyTo, references }), deps);
    const reopened = await getDraft({ account, uid: 5, folder: 'Drafts' }, deps);

    expect(reopened).toMatchObject({
      in_reply_to: inReplyTo,
      thread_references: references,
    });

    const delivered = [];
    const makeSendDeps = () => {
      const transport = {
        sendMail: vi.fn(async mailOptions => { delivered.push(mailOptions); }),
      };
      return {
        query: vi.fn(),
        imapManager: {},
        resolveFromIdentity: vi.fn().mockResolvedValue({
          fromName: 'Sender',
          fromEmail: 'sender@example.com',
          fromReplyTo: 'reply@example.com',
          signature: null,
          aliasId: null,
        }),
        buildSmtpTransport: vi.fn().mockResolvedValue({ transport, account }),
        buildMailOptions: vi.fn(options => options),
        renderRaw: vi.fn().mockResolvedValue(Buffer.from('raw mime')),
        embedInlineDataImages: vi.fn(html => ({ html, attachments: [] })),
        learnSentRecipients: vi.fn(),
        resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
        persistSentCopy: vi.fn().mockResolvedValue({ sentCopySaved: true }),
        randomBytes: vi.fn(() => Buffer.alloc(16, 1)),
      };
    };

    await sendMessage(draftInput({ inReplyTo, references }), makeSendDeps());
    await sendMessage(draftInput({
      inReplyTo: reopened.in_reply_to,
      references: reopened.thread_references,
    }), makeSendDeps());

    expect(delivered).toHaveLength(2);
    expect({
      inReplyTo: delivered[1].inReplyTo,
      references: delivered[1].references,
    }).toEqual({
      inReplyTo: delivered[0].inReplyTo,
      references: delivered[0].references,
    });
  });

  it('keeps append → upsert → delete-old ordering for crash safety', async () => {
    const events = [];
    const imapManager = {
      appendToFolder: vi.fn(async () => {
        events.push('append');
        return { uid: 5 };
      }),
      upsertDraftMessageRecord: vi.fn(async () => { events.push('upsert'); }),
      permanentDeleteMessage: vi.fn(async () => { events.push('delete-imap'); }),
    };
    const query = vi.fn(async (sql) => {
      if (sql.includes("special_use = '\\Drafts'")) return { rows: [{ path: 'Drafts' }] };
      if (sql.startsWith('DELETE FROM messages')) events.push('delete-db');
      return { rows: [] };
    });
    const deps = buildDeps({ imapManager, query });

    const result = await saveDraft(draftInput({
      existingUid: 4,
      existingFolder: 'Drafts',
    }), deps);

    expect(events).toEqual(['append', 'upsert', 'delete-imap', 'delete-db']);
    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledWith(
      account,
      'Drafts',
      5,
      expect.objectContaining({
        subject: 'Draft subject',
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      }),
    );
    expect(result).toMatchObject({ uid: 5, folder: 'Drafts' });
    expect(result.messageId).toMatch(/^<03030303.+@example\.com>$/);
  });

  it('reports an accepted replacement with failed source cleanup only when opted in', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const makeDeps = () => buildDeps({
      imapManager: {
        appendToFolder: vi.fn().mockResolvedValue({ uid: 5 }),
        upsertDraftMessageRecord: vi.fn().mockResolvedValue(undefined),
        permanentDeleteMessage: vi.fn().mockRejectedValue(new Error('Synthetic delete failure')),
      },
      query: vi.fn().mockResolvedValue({ rows: [{ path: 'Drafts' }] }),
    });
    const replacement = draftInput({ existingUid: 4, existingFolder: 'Drafts' });

    const strictDeps = makeDeps();
    await expect(saveDraft({
      ...replacement,
      reportSourceDraftDeletion: true,
    }, strictDeps)).resolves.toMatchObject({
      uid: 5,
      folder: 'Drafts',
      sourceDraftDeleted: false,
    });
    expect(strictDeps.imapManager.appendToFolder).toHaveBeenCalledOnce();

    const legacyDeps = makeDeps();
    const legacy = await saveDraft(replacement, legacyDeps);
    expect(legacy).not.toHaveProperty('sourceDraftDeleted');
    expect(legacyDeps.imapManager.appendToFolder).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it('keeps local persistence non-fatal after a successful append', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const imapManager = {
      appendToFolder: vi.fn().mockResolvedValue({ uid: 5 }),
      upsertDraftMessageRecord: vi.fn().mockRejectedValue(new Error('db down')),
      permanentDeleteMessage: vi.fn(),
    };
    const deps = buildDeps({
      imapManager,
      query: vi.fn().mockResolvedValue({ rows: [{ path: 'Drafts' }] }),
    });

    await expect(saveDraft(draftInput(), deps)).resolves.toMatchObject({ uid: 5, folder: 'Drafts' });
  });

  it('does not upsert without a reliable uid and errors when no Drafts folder resolves', async () => {
    const imapManager = {
      appendToFolder: vi.fn().mockResolvedValue({ uid: null }),
      upsertDraftMessageRecord: vi.fn(),
      permanentDeleteMessage: vi.fn(),
    };
    const deps = buildDeps({
      imapManager,
      query: vi.fn().mockResolvedValue({ rows: [{ path: 'Drafts' }] }),
    });
    await saveDraft(draftInput(), deps);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();

    const missingDeps = buildDeps({
      imapManager,
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });
    await expect(saveDraft(draftInput(), missingDeps)).rejects.toMatchObject({
      message: 'No Drafts folder found for this account',
      status: 422,
      expose: true,
    });
  });
});

describe('draft persistence helpers', () => {
  it('deletes from IMAP before removing the local row', async () => {
    const events = [];
    const deps = {
      imapManager: {
        permanentDeleteMessage: vi.fn(async () => { events.push('imap'); }),
      },
      query: vi.fn(async () => {
        events.push('db');
        return { rows: [] };
      }),
    };
    await expect(deleteDraft({ account, uid: 9, folder: 'Drafts' }, deps)).resolves.toEqual({ ok: true });
    expect(events).toEqual(['imap', 'db']);
  });

  it('reports accepted IMAP deletion with pending local cleanup only when opted in', async () => {
    const makeDeps = () => ({
      imapManager: {
        permanentDeleteMessage: vi.fn().mockResolvedValue(undefined),
      },
      query: vi.fn().mockRejectedValue(new Error('Synthetic local cleanup failure')),
    });

    const strictDeps = makeDeps();
    await expect(deleteDraft({
      account,
      uid: 9,
      folder: 'Drafts',
      reportDeletionAcceptance: true,
    }, strictDeps)).resolves.toEqual({ ok: true, localCleanupPending: true });
    expect(strictDeps.imapManager.permanentDeleteMessage).toHaveBeenCalledOnce();

    const legacyDeps = makeDeps();
    await expect(deleteDraft({
      account,
      uid: 9,
      folder: 'Drafts',
    }, legacyDeps)).rejects.toThrow('Synthetic local cleanup failure');
  });

  it('lists and gets drafts from the already-scoped account', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ uid: 7, subject: 'Draft' }] })
      .mockResolvedValueOnce({ rows: [{ uid: 7, subject: 'Draft' }] });

    const mappedAccount = { ...account, folder_mappings: { drafts: 'Drafts' } };
    await expect(listDrafts({
      userId: 'user-1',
      account: mappedAccount,
      limit: 10,
      offset: 0,
    }, { query }))
      .resolves.toEqual({ drafts: [{ uid: 7, subject: 'Draft' }], total: 1 });
    await expect(getDraft({ account: mappedAccount, uid: 7, folder: 'Drafts' }, { query }))
      .resolves.toEqual({ uid: 7, subject: 'Draft' });

    expect(query.mock.calls[0][1][0]).toBe('account-1');
    expect(query.mock.calls[2][1]).toEqual(['account-1', 7, 'Drafts']);
  });

  it('owner-scopes claimed source filtering in both draft count and page queries', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ uid: 8, subject: 'Unclaimed draft' }] });
    const mappedAccount = { ...account, folder_mappings: { drafts: 'Drafts' } };

    await expect(listDrafts({
      userId: 'user-1',
      account: mappedAccount,
      limit: 25,
      offset: 5,
    }, { query })).resolves.toEqual({
      drafts: [{ uid: 8, subject: 'Unclaimed draft' }],
      total: 1,
    });

    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('FROM messages m');
      expect(sql).toContain(`AND NOT EXISTS (
       SELECT 1 FROM compose_sessions cs
       WHERE cs.user_id = $2
         AND cs.source_draft_account_id = m.account_id
         AND cs.source_draft_folder = m.folder
         AND cs.source_draft_uid = m.uid
     )`);
    }
    expect(query.mock.calls[0][1]).toEqual(['account-1', 'user-1', 'Drafts']);
    expect(query.mock.calls[1][1]).toEqual(['account-1', 'user-1', 'Drafts', 25, 5]);
  });
});
