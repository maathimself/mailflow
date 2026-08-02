import { describe, expect, it, vi } from 'vitest';
import {
  canonicalCompose,
  claimDraftIntoComposeSession,
  closeComposeSession,
  discardComposeSession,
  sendComposeSession,
  sessionToComposeInput,
  sourceDraftChanged,
} from './composeSessionLifecycle.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const DESTINATION_ACCOUNT_ID = '00000000-0000-4000-8000-000000000040';
const ALIAS_ID = '00000000-0000-4000-8000-000000000002';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000003';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000004';
const USER_ID = '00000000-0000-4000-8000-000000000010';
const CLAIMED_SESSION_ID = '00000000-0000-4000-8000-000000000011';
const CLAIMED_ATTACHMENT_ID = '00000000-0000-4000-8000-000000000012';
const SECOND_SESSION_ID = '00000000-0000-4000-8000-000000000013';

function completeSession(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000005',
    slot: 4,
    accountId: ACCOUNT_ID,
    aliasId: ALIAS_ID,
    mode: 'reply',
    to: ['A <a@example.com>'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    body: '<p>Body</p>',
    bodyIsHtml: true,
    quotedBody: null,
    quotedBodyHtml: null,
    editedSignature: '<p>Sig</p>',
    forwardedAttachments: [{ messageId: MESSAGE_ID, part: '2' }],
    priority: 'high',
    inReplyTo: '<source@example.com>',
    references: ['<root@example.com>', '<source@example.com>'],
    fromChanged: true,
    attachments: [{
      id: ATTACHMENT_ID,
      filename: 'report.pdf',
      contentType: 'application/pdf',
      byteCount: 3,
      content: Buffer.from('pdf'),
      createdAt: '2026-08-01T00:00:00.000Z',
    }],
    sourceInitialRevision: null,
    presentationState: 'minimized',
    operationState: 'closing',
    operationToken: '00000000-0000-4000-8000-000000000006',
    revision: 9,
    fieldRevisions: { subject: 8 },
    lastFocusedAt: '2026-08-01T01:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('sessionToComposeInput', () => {
  it('maps every shared draft/send input and base64-encodes uploaded bytes', () => {
    const account = { id: ACCOUNT_ID, email_address: 'sender@example.com' };

    expect(sessionToComposeInput(completeSession(), account, { userId: 'user-1' }))
      .toEqual({
        userId: 'user-1',
        account,
        aliasId: ALIAS_ID,
        to: ['A <a@example.com>'],
        cc: [],
        bcc: [],
        subject: 'Hello',
        body: '<p>Body</p>',
        bodyIsHtml: true,
        quotedBody: null,
        quotedBodyHtml: null,
        editedSignature: '<p>Sig</p>',
        priority: 'high',
        inReplyTo: '<source@example.com>',
        references: ['<root@example.com>', '<source@example.com>'],
        attachments: [{
          filename: 'report.pdf',
          content: Buffer.from('pdf').toString('base64'),
          contentType: 'application/pdf',
        }],
        forwardedAttachments: [{ messageId: MESSAGE_ID, part: '2' }],
      });
  });

  it('preserves plaintext representation and normalized empty defaults', () => {
    const input = sessionToComposeInput(completeSession({
      aliasId: null,
      to: undefined,
      cc: undefined,
      bcc: undefined,
      subject: undefined,
      body: 'Plain body',
      bodyIsHtml: false,
      quotedBody: undefined,
      quotedBodyHtml: undefined,
      editedSignature: undefined,
      forwardedAttachments: undefined,
      priority: undefined,
      inReplyTo: undefined,
      references: undefined,
      attachments: undefined,
    }), { id: ACCOUNT_ID }, { userId: 'user-1' });

    expect(input).toMatchObject({
      aliasId: null,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      body: 'Plain body',
      bodyIsHtml: false,
      quotedBody: null,
      quotedBodyHtml: null,
      editedSignature: null,
      priority: 'normal',
      inReplyTo: null,
      references: [],
      attachments: [],
      forwardedAttachments: [],
    });
  });

  it('provides a close-time seam for materialized forwarded attachment bytes', () => {
    const input = sessionToComposeInput(completeSession(), { id: ACCOUNT_ID }, {
      userId: 'user-1',
      materializedForwardedAttachments: [{
        filename: 'forwarded.txt',
        contentType: 'text/plain',
        content: Buffer.from('forwarded'),
      }],
    });

    expect(input.forwardedAttachments).toEqual([]);
    expect(input.attachments).toEqual([
      {
        filename: 'report.pdf',
        content: Buffer.from('pdf').toString('base64'),
        contentType: 'application/pdf',
      },
      {
        filename: 'forwarded.txt',
        content: Buffer.from('forwarded').toString('base64'),
        contentType: 'text/plain',
      },
    ]);
  });

  it.each([
    ['uploaded', completeSession({
      attachments: [{ ...completeSession().attachments[0], content: undefined }],
    }), {}],
    ['materialized forwarded', completeSession(), {
      materializedForwardedAttachments: [{
        filename: 'forwarded.txt',
        contentType: 'text/plain',
        content: { unsupported: true },
      }],
    }],
  ])('rejects missing or unsupported %s attachment content', (_kind, session, options) => {
    let thrown;
    try {
      sessionToComposeInput(session, { id: ACCOUNT_ID }, { userId: 'user-1', ...options });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'invalid_compose_attachment_content',
      status: 500,
      expose: false,
    });
  });

  it('preserves canonical base64 and converts Uint8Array attachment content', () => {
    const input = sessionToComposeInput(completeSession({
      attachments: [
        { ...completeSession().attachments[0], content: 'cGRm' },
        {
          id: '00000000-0000-4000-8000-000000000009',
          filename: 'typed.bin',
          contentType: 'application/octet-stream',
          byteCount: 3,
          content: new Uint8Array([1, 2, 3]),
        },
      ],
    }), { id: ACCOUNT_ID }, { userId: 'user-1' });

    expect(input.attachments.map(attachment => attachment.content)).toEqual([
      'cGRm',
      Buffer.from([1, 2, 3]).toString('base64'),
    ]);
  });
});

describe('canonicalCompose and sourceDraftChanged', () => {
  it('captures deterministic meaningful state and attachment fingerprints only', () => {
    const session = completeSession();
    const canonical = canonicalCompose(session);

    expect(canonical).toEqual({
      accountId: ACCOUNT_ID,
      aliasId: ALIAS_ID,
      mode: 'reply',
      to: ['A <a@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: '<p>Body</p>',
      bodyIsHtml: true,
      quotedBody: null,
      quotedBodyHtml: null,
      editedSignature: '<p>Sig</p>',
      forwardedAttachments: [{ messageId: MESSAGE_ID, part: '2' }],
      priority: 'high',
      inReplyTo: '<source@example.com>',
      references: ['<root@example.com>', '<source@example.com>'],
      fromChanged: true,
      attachments: [{
        id: ATTACHMENT_ID,
        filename: 'report.pdf',
        contentType: 'application/pdf',
        byteCount: 3,
      }],
    });
    expect(canonical).not.toHaveProperty('slot');
    expect(canonical).not.toHaveProperty('revision');
    expect(canonical).not.toHaveProperty('presentationState');
    expect(canonical).not.toHaveProperty('operationState');
    expect(canonical.attachments[0]).not.toHaveProperty('content');
    expect(canonical.attachments[0]).not.toHaveProperty('createdAt');
  });

  it('treats revision, timestamps, presentation, operation, slot, and bytes as irrelevant', () => {
    const initial = completeSession();
    const sourceInitialRevision = canonicalCompose(initial);
    const current = completeSession({
      sourceInitialRevision,
      slot: 9,
      revision: 99,
      fieldRevisions: { body: 99 },
      presentationState: 'expanded',
      operationState: 'sending',
      operationToken: '00000000-0000-4000-8000-000000000007',
      updatedAt: '2026-08-02T00:00:00.000Z',
      attachments: [{ ...initial.attachments[0], content: Buffer.from('new') }],
    });

    expect(sourceDraftChanged(current)).toBe(false);
  });

  it.each([
    ['recipient', { to: ['B <b@example.com>'] }],
    ['alias', { aliasId: null }],
    ['plaintext mode', { bodyIsHtml: false }],
    ['priority', { priority: 'low' }],
    ['quoted content', { quotedBody: 'Quoted' }],
    ['signature', { editedSignature: '<p>Different</p>' }],
    ['forwarded reference', { forwardedAttachments: [] }],
    ['attachment fingerprint', {
      attachments: [{ ...completeSession().attachments[0], byteCount: 4 }],
    }],
  ])('detects a changed %s', (_label, change) => {
    const initial = completeSession();
    const current = completeSession({
      ...change,
      sourceInitialRevision: canonicalCompose(initial),
    });

    expect(sourceDraftChanged(current)).toBe(true);
  });

  it('sorts attachment fingerprints by stable id', () => {
    const second = {
      id: '00000000-0000-4000-8000-000000000008',
      filename: 'second.txt',
      contentType: 'text/plain',
      byteCount: 2,
      content: Buffer.from('ok'),
    };
    const initial = completeSession({
      attachments: [second, completeSession().attachments[0]],
    });
    const current = completeSession({
      attachments: [completeSession().attachments[0], second],
      sourceInitialRevision: canonicalCompose(initial),
    });

    expect(sourceDraftChanged(current)).toBe(false);
  });
});

function sourceDraft(overrides = {}) {
  return {
    id: ACCOUNT_ID,
    account_id: ACCOUNT_ID,
    uid: 41,
    folder: '[Synthetic]/Drafts',
    message_id: '<synthetic-draft@example.com>',
    subject: 'Synthetic draft',
    to_addresses: [{ name: 'Recipient', email: 'recipient@example.com' }],
    cc_addresses: [],
    from_email: 'sender@example.com',
    body_html: '<p>Synthetic body</p>',
    body_text: 'Synthetic body',
    in_reply_to: '<synthetic-source@example.com>',
    thread_references: '<synthetic-root@example.com> <synthetic-source@example.com>',
    attachments: [{
      part: '2',
      filename: 'synthetic.txt',
      type: 'text/plain',
      size: 15,
    }],
    folder_mappings: { drafts: '[Synthetic]/Drafts' },
    email_address: 'sender@example.com',
    ...overrides,
  };
}

function sessionRowFromInsert(params) {
  return {
    id: CLAIMED_SESSION_ID,
    user_id: params[0],
    slot: params[1],
    account_id: params[2],
    alias_id: params[3],
    mode: 'new',
    to_recipients: params[4],
    cc_recipients: params[5],
    bcc_recipients: '[]',
    subject: params[6],
    body: params[7],
    body_is_html: params[8],
    quoted_body: null,
    quoted_body_html: null,
    edited_signature: null,
    forwarded_attachments: '[]',
    priority: 'normal',
    in_reply_to: params[9],
    thread_references: params[10],
    reply_all_recipients: params[11],
    from_changed: false,
    source_draft_account_id: params[12],
    source_draft_folder: params[13],
    source_draft_uid: params[14],
    source_draft_message_id: params[15],
    source_initial_revision: params[16],
    presentation_state: 'expanded',
    operation_state: 'idle',
    operation_token: null,
    revision: 1,
    field_revisions: '{}',
    last_focused_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

function claimDeps({ draft = sourceDraft(), occupiedSlots = [], duplicate = false } = {}) {
  const attachmentRows = [];
  const clientQuery = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (normalized.includes('FROM compose_sessions')
        && normalized.includes('source_draft_account_id')) {
      return { rows: duplicate ? [{ id: CLAIMED_SESSION_ID }] : [] };
    }
    if (normalized.includes('FROM generate_series(1, 9)')) {
      const requested = params[1];
      const slot = requested == null
        ? Array.from({ length: 9 }, (_, index) => index + 1)
          .find(candidate => !occupiedSlots.includes(candidate))
        : (!occupiedSlots.includes(requested) ? requested : undefined);
      return { rows: slot ? [{ slot }] : [] };
    }
    if (normalized.startsWith('INSERT INTO compose_sessions')) {
      const sessionRow = sessionRowFromInsert(params);
      return { rows: [sessionRow] };
    }
    if (normalized.startsWith('INSERT INTO compose_session_attachments')) {
      const [id, sessionId, filename, contentType, byteCount, content] = params;
      const row = {
        id,
        session_id: sessionId,
        filename,
        content_type: contentType,
        byte_count: byteCount,
        content,
        created_at: '2026-08-01T00:00:00.000Z',
      };
      attachmentRows.push(row);
      return { rows: [row] };
    }
    throw new Error(`Unexpected transaction SQL: ${normalized}`);
  };
  const query = vi.fn(async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT m.*, a.*')) return { rows: [draft] };
    if (normalized.includes("special_use='\\Drafts'")) return { rows: [] };
    if (normalized.startsWith('SELECT id FROM account_aliases')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${normalized} ${JSON.stringify(params)}`);
  });
  const imapManager = {
    fetchMessageBody: vi.fn(),
    fetchAttachment: vi.fn(async () => Buffer.from('synthetic bytes')),
    permanentDeleteMessage: vi.fn(),
  };
  const withTransaction = vi.fn(async callback => callback({ query: clientQuery }));
  return {
    deps: {
      query,
      withTransaction,
      imapManager,
      randomUUID: vi.fn(() => CLAIMED_ATTACHMENT_ID),
      broadcast: vi.fn(),
    },
    attachmentRows,
  };
}

describe('claimDraftIntoComposeSession', () => {
  it('owner-scopes the source, fetches every attachment before allocation, and snapshots persisted ids', async () => {
    const fake = claimDeps({ occupiedSlots: [1] });

    const claimed = await claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
      replyAllRecipients: [' Synthetic Copied <copied@example.com> '],
    }, fake.deps);

    const sourceCall = fake.deps.query.mock.calls[0];
    expect(sourceCall[0].replace(/\s+/g, ' ')).toContain(
      'SELECT m.*, a.* FROM messages m JOIN email_accounts a ON a.id=m.account_id',
    );
    expect(sourceCall[0].replace(/\s+/g, ' ')).toContain(
      'm.account_id=$1 AND m.folder=$2 AND m.uid=$3 AND a.user_id=$4 AND m.is_deleted=false',
    );
    expect(sourceCall[1]).toEqual([ACCOUNT_ID, '[Synthetic]/Drafts', 41, USER_ID]);
    expect(fake.deps.imapManager.fetchAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT_ID }),
      41,
      '[Synthetic]/Drafts',
      '2',
    );
    expect(fake.deps.imapManager.fetchAttachment.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.withTransaction.mock.invocationCallOrder[0]);
    expect(claimed).toMatchObject({
      id: CLAIMED_SESSION_ID,
      slot: 2,
      accountId: ACCOUNT_ID,
      subject: 'Synthetic draft',
      body: '<p>Synthetic body</p>',
      bodyIsHtml: true,
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
      attachments: [{
        id: CLAIMED_ATTACHMENT_ID,
        filename: 'synthetic.txt',
        contentType: 'text/plain',
        byteCount: 15,
      }],
    });
    expect(claimed.to).toEqual(['Recipient <recipient@example.com>']);
    expect(claimed.references).toEqual([
      '<synthetic-root@example.com>',
      '<synthetic-source@example.com>',
    ]);
    expect(claimed.sourceInitialRevision).toEqual(canonicalCompose(claimed));
    expect(fake.attachmentRows[0].id).toBe(CLAIMED_ATTACHMENT_ID);
    expect(claimed.sourceInitialRevision.attachments[0].id).toBe(fake.attachmentRows[0].id);
    expect(fake.attachmentRows[0].content).toEqual(Buffer.from('synthetic bytes'));
    expect(fake.deps.imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(fake.deps.query.mock.calls.flatMap(call => call[0])).not.toContain('DELETE FROM messages');
  });

  it('fetches a missing body and uses plaintext plus fetched attachment descriptors truthfully', async () => {
    const fake = claimDeps({
      draft: sourceDraft({ body_html: null, body_text: null, attachments: [] }),
    });
    fake.deps.imapManager.fetchMessageBody.mockResolvedValueOnce({
      html: null,
      text: 'Fetched synthetic body',
      attachments: [{
        part: '3', filename: 'fetched.bin', type: 'application/octet-stream', size: 4,
      }],
    });
    fake.deps.imapManager.fetchAttachment.mockResolvedValueOnce(Buffer.from('data'));

    const claimed = await claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps);

    expect(fake.deps.imapManager.fetchMessageBody).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT_ID }), 41, '[Synthetic]/Drafts',
    );
    expect(fake.deps.imapManager.fetchAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT_ID }), 41, '[Synthetic]/Drafts', '3',
    );
    expect(claimed).toMatchObject({ body: 'Fetched synthetic body', bodyIsHtml: false });
    expect(claimed.attachments[0]).toMatchObject({ filename: 'fetched.bin', byteCount: 4 });
  });

  it('fetches missing descriptors for a cached attachment-bearing draft without replacing its body', async () => {
    const fake = claimDeps({
      draft: sourceDraft({
        body_html: '<p>Cached synthetic body</p>',
        body_text: 'Cached synthetic body',
        has_attachments: true,
        attachments: [],
      }),
    });
    fake.deps.imapManager.fetchMessageBody.mockResolvedValueOnce({
      html: '<p>Freshly fetched body</p>',
      text: 'Freshly fetched body',
      attachments: [{
        part: '4', filename: 'recovered.bin', type: 'application/octet-stream', size: 5,
      }],
    });
    fake.deps.imapManager.fetchAttachment.mockResolvedValueOnce(Buffer.from('bytes'));

    const claimed = await claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps);

    expect(fake.deps.imapManager.fetchMessageBody).toHaveBeenCalledOnce();
    expect(claimed).toMatchObject({
      body: '<p>Cached synthetic body</p>',
      bodyIsHtml: true,
      attachments: [{ filename: 'recovered.bin', byteCount: 5 }],
    });
    expect(fake.deps.imapManager.fetchAttachment.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.withTransaction.mock.invocationCallOrder[0]);
  });

  it('fails closed when an attachment-bearing draft still has no descriptors after live fetch', async () => {
    const fake = claimDeps({
      draft: sourceDraft({ has_attachments: true, attachments: [] }),
    });
    fake.deps.imapManager.fetchMessageBody.mockResolvedValueOnce({
      html: '<p>Fetched synthetic body</p>',
      text: 'Fetched synthetic body',
      attachments: [],
    });

    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_source_attachments_incomplete',
      status: 409,
      expose: true,
    });
    expect(fake.deps.withTransaction).not.toHaveBeenCalled();
  });

  it('sanitizes live-fetched HTML before placing it in the authoritative session', async () => {
    const fake = claimDeps({
      draft: sourceDraft({ body_html: null, body_text: null, attachments: [] }),
    });
    fake.deps.imapManager.fetchMessageBody.mockResolvedValueOnce({
      html: '<p onclick="syntheticHandler()">Safe text</p><script>syntheticScript()</script>',
      text: 'Safe text',
      attachments: [],
    });

    const claimed = await claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps);

    expect(claimed.body).toContain('Safe text');
    expect(claimed.body).not.toMatch(/script|onclick|syntheticHandler|syntheticScript/i);
    expect(claimed.bodyIsHtml).toBe(true);
  });

  it('treats whitespace-only live HTML as absent so nonempty plaintext wins', async () => {
    const fake = claimDeps({
      draft: sourceDraft({ body_html: null, body_text: null, attachments: [] }),
    });
    fake.deps.imapManager.fetchMessageBody.mockResolvedValueOnce({
      html: '  \n\t ',
      text: 'Fetched plaintext body',
      attachments: [],
    });

    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps)).resolves.toMatchObject({
      body: 'Fetched plaintext body',
      bodyIsHtml: false,
    });
  });

  it('accepts an actual special-use Drafts path when no account mapping matches', async () => {
    const draft = sourceDraft({ folder_mappings: {}, folder: 'Localized/Entwürfe', attachments: [] });
    const fake = claimDeps({ draft });
    fake.deps.query.mockImplementation(async (sql) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT m.*, a.*')) return { rows: [draft] };
      if (normalized.includes("special_use='\\Drafts'")) {
        return { rows: [{ path: 'Localized/Entwürfe' }] };
      }
      if (normalized.startsWith('SELECT id FROM account_aliases')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${normalized}`);
    });

    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: 'Localized/Entwürfe',
      uid: 41,
    }, fake.deps)).resolves.toMatchObject({ sourceDraftFolder: 'Localized/Entwürfe' });
    expect(fake.deps.query).toHaveBeenCalledWith(
      expect.stringContaining("special_use='\\Drafts'"),
      [ACCOUNT_ID, 'Localized/Entwürfe'],
    );
  });

  it('rejects a folder that is neither mapped nor marked as Drafts before IMAP or allocation', async () => {
    const fake = claimDeps({
      draft: sourceDraft({ folder_mappings: {}, folder: 'Synthetic/Archive' }),
    });

    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: 'Synthetic/Archive',
      uid: 41,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_source_not_draft',
      status: 400,
    });
    expect(fake.deps.imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(fake.deps.imapManager.fetchAttachment).not.toHaveBeenCalled();
    expect(fake.deps.withTransaction).not.toHaveBeenCalled();
  });

  it('returns an owner-scoped not-found without opening an allocation transaction', async () => {
    const fake = claimDeps();
    fake.deps.query.mockResolvedValueOnce({ rows: [] });

    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_source_draft_not_found',
      status: 404,
    });
    expect(fake.deps.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a duplicate source tuple with a stable conflict and leaves the source intact', async () => {
    const fake = claimDeps({ duplicate: true });

    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, fake.deps)).rejects.toMatchObject({ code: 'compose_draft_claimed', status: 409 });
    expect(fake.deps.imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('honors a requested free slot and reports occupied and exhausted allocation distinctly', async () => {
    const requested = claimDeps({ occupiedSlots: [1, 2] });
    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
      requestedSlot: 7,
    }, requested.deps)).resolves.toMatchObject({ slot: 7 });

    const occupied = claimDeps({ occupiedSlots: [7] });
    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
      requestedSlot: 7,
    }, occupied.deps)).rejects.toMatchObject({ code: 'compose_slot_occupied', status: 409 });

    const exhausted = claimDeps({ occupiedSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    await expect(claimDraftIntoComposeSession({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
    }, exhausted.deps)).rejects.toMatchObject({ code: 'compose_session_limit', status: 409 });
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function closeSession(overrides = {}) {
  return completeSession({
    id: CLAIMED_SESSION_ID,
    slot: 3,
    accountId: ACCOUNT_ID,
    aliasId: null,
    mode: 'new',
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    bodyIsHtml: true,
    quotedBody: null,
    quotedBodyHtml: null,
    editedSignature: null,
    forwardedAttachments: [],
    priority: 'normal',
    inReplyTo: null,
    references: [],
    fromChanged: false,
    attachments: [],
    sourceDraftAccountId: null,
    sourceDraftFolder: null,
    sourceDraftUid: null,
    sourceDraftMessageId: null,
    sourceInitialRevision: null,
    operationState: 'closing',
    operationToken: '00000000-0000-4000-8000-000000000020',
    revision: 7,
    ...overrides,
  });
}

function closeDeps(session = closeSession()) {
  const account = {
    id: ACCOUNT_ID,
    user_id: USER_ID,
    email_address: 'sender@example.com',
  };
  const claimComposeOperation = vi.fn().mockResolvedValue(session);
  const releaseComposeOperation = vi.fn().mockResolvedValue(true);
  const deleteClaimedComposeSession = vi.fn().mockResolvedValue(true);
  const saveDraft = vi.fn().mockResolvedValue({
    uid: 72,
    folder: '[Synthetic]/Drafts',
    messageId: '<saved-synthetic@example.com>',
  });
  const deleteDraft = vi.fn().mockResolvedValue({ ok: true });
  const query = vi.fn(async (sql) => {
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    throw new Error(`Unexpected close SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
  });
  return {
    account,
    deps: {
      query,
      imapManager: { fetchAttachment: vi.fn() },
      draftService: { saveDraft, deleteDraft },
      claimComposeOperation,
      releaseComposeOperation,
      deleteClaimedComposeSession,
      broadcast: vi.fn(),
    },
  };
}

function sendSession(overrides = {}) {
  return closeSession({
    operationState: 'sending',
    to: ['Recipient <recipient@example.com>'],
    subject: 'Synthetic send subject',
    body: 'Synthetic send body',
    bodyIsHtml: false,
    ...overrides,
  });
}

function sendDeps(session = sendSession(), { preference = 0 } = {}) {
  const destinationAccount = {
    id: session.accountId || ACCOUNT_ID,
    user_id: USER_ID,
    email_address: 'sender@example.com',
  };
  const sourceAccount = {
    id: session.sourceDraftAccountId || ACCOUNT_ID,
    user_id: USER_ID,
    email_address: 'source@example.com',
  };
  const claimComposeOperation = vi.fn().mockResolvedValue(session);
  const releaseComposeOperation = vi.fn().mockResolvedValue(true);
  const deleteClaimedComposeSession = vi.fn().mockResolvedValue(true);
  const sendOrEnqueue = vi.fn().mockResolvedValue({
    ok: true,
    messageId: '<sent-synthetic@example.com>',
    sentCopySaved: true,
    receipt: { subject: 'Synthetic send subject' },
  });
  const deleteDraft = vi.fn().mockResolvedValue({ ok: true });
  const normalizeUndoWindow = vi.fn((requested, fallback) => requested ?? fallback ?? 0);
  const query = vi.fn(async (sql, params) => {
    if (sql.includes('FROM email_accounts')) {
      if (params[0] === destinationAccount.id) return { rows: [destinationAccount] };
      if (params[0] === sourceAccount.id) return { rows: [sourceAccount] };
      return { rows: [] };
    }
    if (sql.includes('FROM users')) {
      return { rows: [{ preferences: { undoSendSeconds: preference, plaintextEmail: true } }] };
    }
    throw new Error(`Unexpected send SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
  });
  return {
    destinationAccount,
    sourceAccount,
    deps: {
      query,
      imapManager: { fetchAttachment: vi.fn() },
      redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
      refreshMicrosoftToken: vi.fn(),
      sendService: { sendOrEnqueue },
      outboxService: { normalizeUndoWindow, enqueue: vi.fn() },
      draftService: { deleteDraft },
      claimComposeOperation,
      releaseComposeOperation,
      deleteClaimedComposeSession,
      broadcast: vi.fn(),
    },
  };
}

describe('closeComposeSession', () => {
  it('claims an atomic final patch and deletes an empty new session by token without saving', async () => {
    const fake = closeDeps();
    const changes = { subject: '' };

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 6,
      changes,
    }, fake.deps)).resolves.toEqual({ closed: true, slot: 3, draft: null });

    expect(fake.deps.claimComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 6,
      operation: 'closing',
      changes,
    }, fake.deps);
    expect(fake.deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
    expect(fake.deps.broadcast).toHaveBeenCalledWith({
      type: 'compose_sessions_updated',
      action: 'closed',
      sessionId: CLAIMED_SESSION_ID,
      slot: 3,
      revision: 7,
    }, USER_ID);
  });

  it('awaits saving a meaningful new draft before deleting the claimed session', async () => {
    const fake = closeDeps(closeSession({ subject: 'Synthetic subject' }));
    const save = deferred();
    fake.deps.draftService.saveDraft.mockReturnValueOnce(save.promise);

    const closing = closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps);
    await vi.waitFor(() => expect(fake.deps.draftService.saveDraft).toHaveBeenCalledOnce());
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();

    save.resolve({
      uid: 72,
      folder: '[Synthetic]/Drafts',
      messageId: '<saved-synthetic@example.com>',
    });
    await expect(closing).resolves.toEqual({
      closed: true,
      slot: 3,
      draft: {
        accountId: ACCOUNT_ID,
        uid: 72,
        folder: '[Synthetic]/Drafts',
        messageId: '<saved-synthetic@example.com>',
      },
    });
    expect(fake.deps.draftService.saveDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0]);
  });

  it('deletes the token but leaves an unchanged claimed source draft intact', async () => {
    const initial = closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      sourceDraftMessageId: '<source-synthetic@example.com>',
    });
    const fake = closeDeps({ ...initial, sourceInitialRevision: canonicalCompose(initial) });

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).resolves.toEqual({ closed: true, slot: 3, draft: null });

    expect(fake.deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).toHaveBeenCalledOnce();
  });

  it('saves a changed claimed source with existing locators before token deletion', async () => {
    const initial = closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      subject: 'Initial synthetic subject',
    });
    const claimed = {
      ...initial,
      subject: 'Changed synthetic subject',
      sourceInitialRevision: canonicalCompose(initial),
    };
    const fake = closeDeps(claimed);
    const save = deferred();
    fake.deps.draftService.saveDraft.mockReturnValueOnce(save.promise);

    const closing = closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps);
    await vi.waitFor(() => expect(fake.deps.draftService.saveDraft).toHaveBeenCalledOnce());
    expect(fake.deps.draftService.saveDraft.mock.calls[0][0]).toMatchObject({
      existingUid: 41,
      existingFolder: '[Synthetic]/Drafts',
      reportSourceDraftDeletion: true,
      subject: 'Changed synthetic subject',
    });
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();

    save.resolve({ uid: 73, folder: '[Synthetic]/Drafts', messageId: null });
    await closing;
    expect(fake.deps.draftService.saveDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0]);
  });

  it('moves a claimed source across owned accounts without passing source locators to destination save', async () => {
    const initial = closeSession({
      accountId: ACCOUNT_ID,
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      subject: 'Initial synthetic subject',
    });
    const claimed = {
      ...initial,
      accountId: DESTINATION_ACCOUNT_ID,
      subject: 'Changed synthetic subject',
      sourceInitialRevision: canonicalCompose(initial),
    };
    const fake = closeDeps(claimed);
    const sourceAccount = fake.account;
    const destinationAccount = {
      id: DESTINATION_ACCOUNT_ID,
      user_id: USER_ID,
      email_address: 'destination@example.com',
    };
    fake.deps.query.mockImplementation(async (sql, params) => {
      if (!sql.includes('FROM email_accounts')) throw new Error('Unexpected cross-account SQL');
      if (params[0] === DESTINATION_ACCOUNT_ID) return { rows: [destinationAccount] };
      if (params[0] === ACCOUNT_ID) return { rows: [sourceAccount] };
      return { rows: [] };
    });
    const save = deferred();
    const sourceDelete = deferred();
    fake.deps.draftService.saveDraft.mockReturnValueOnce(save.promise);
    fake.deps.draftService.deleteDraft.mockReturnValueOnce(sourceDelete.promise);

    const closing = closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps);
    await vi.waitFor(() => expect(fake.deps.draftService.saveDraft).toHaveBeenCalledOnce());

    expect(fake.deps.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM email_accounts'),
      [DESTINATION_ACCOUNT_ID, USER_ID],
    );
    expect(fake.deps.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM email_accounts'),
      [ACCOUNT_ID, USER_ID],
    );
    expect(fake.deps.draftService.saveDraft.mock.calls[0][0]).toMatchObject({
      account: destinationAccount,
      subject: 'Changed synthetic subject',
    });
    expect(fake.deps.draftService.saveDraft.mock.calls[0][0]).not.toHaveProperty('existingUid');
    expect(fake.deps.draftService.saveDraft.mock.calls[0][0]).not.toHaveProperty('existingFolder');
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();

    save.resolve({ uid: 73, folder: '[Destination]/Drafts', messageId: null });
    await vi.waitFor(() => expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledOnce());
    expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledWith({
      account: sourceAccount,
      uid: 41,
      folder: '[Synthetic]/Drafts',
    }, fake.deps);
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();

    sourceDelete.resolve({ ok: true });
    await expect(closing).resolves.toMatchObject({
      closed: true,
      draft: { accountId: DESTINATION_ACCOUNT_ID, uid: 73 },
    });
    expect(fake.deps.draftService.saveDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.draftService.deleteDraft.mock.invocationCallOrder[0]);
    expect(fake.deps.draftService.deleteDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0]);
    expect(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.broadcast.mock.invocationCallOrder[0]);
  });

  it('keeps a cross-account close claimed when source deletion fails after destination save', async () => {
    const initial = closeSession({
      accountId: ACCOUNT_ID,
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      subject: 'Initial synthetic subject',
    });
    const fake = closeDeps({
      ...initial,
      accountId: DESTINATION_ACCOUNT_ID,
      subject: 'Changed synthetic subject',
      sourceInitialRevision: canonicalCompose(initial),
    });
    const destinationAccount = {
      id: DESTINATION_ACCOUNT_ID,
      user_id: USER_ID,
      email_address: 'destination@example.com',
    };
    fake.deps.query.mockImplementation(async (_sql, params) => ({
      rows: [params[0] === DESTINATION_ACCOUNT_ID ? destinationAccount : fake.account],
    }));
    const failure = Object.assign(new Error('Synthetic source deletion failure'), {
      code: 'synthetic_source_delete',
    });
    fake.deps.draftService.deleteDraft.mockRejectedValueOnce(failure);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_close_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });

    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
    expect(failure.code).toBe('synthetic_source_delete');
  });

  it('keeps a same-account replacement claimed when APPEND succeeds but source cleanup is incomplete', async () => {
    const initial = closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      subject: 'Initial synthetic subject',
    });
    const fake = closeDeps({
      ...initial,
      subject: 'Changed synthetic subject',
      sourceInitialRevision: canonicalCompose(initial),
    });
    fake.deps.draftService.saveDraft.mockResolvedValueOnce({
      uid: 73,
      folder: '[Synthetic]/Drafts',
      messageId: null,
      sourceDraftDeleted: false,
    });

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_close_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });

    expect(fake.deps.draftService.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ reportSourceDraftDeletion: true }),
      fake.deps,
    );
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
  });

  it('blocks close retry when token deletion fails after a meaningful draft was accepted', async () => {
    const session = closeSession({ subject: 'Synthetic subject' });
    const fake = closeDeps(session);
    const operationInProgress = Object.assign(new Error('Operation in progress'), {
      code: 'compose_operation_in_progress', status: 409, expose: true,
    });
    fake.deps.claimComposeOperation
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(operationInProgress);
    fake.deps.deleteClaimedComposeSession.mockRejectedValueOnce(
      new Error('Synthetic database disconnect'),
    );
    const input = {
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    };

    await expect(closeComposeSession(input, fake.deps)).rejects.toMatchObject({
      code: 'compose_close_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();

    await expect(closeComposeSession(input, fake.deps)).rejects.toBe(operationInProgress);
    expect(fake.deps.draftService.saveDraft).toHaveBeenCalledOnce();
  });

  it('treats an owner-scoped absent row as completed close cleanup after acceptance', async () => {
    const fake = closeDeps(closeSession({ subject: 'Synthetic subject' }));
    const query = fake.deps.query.getMockImplementation();
    fake.deps.query.mockImplementation((sql, params) => (
      sql.includes('FROM compose_sessions') ? { rows: [] } : query(sql, params)
    ));
    fake.deps.deleteClaimedComposeSession.mockResolvedValueOnce(false);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).resolves.toMatchObject({ closed: true });
    expect(fake.deps.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM compose_sessions[\s\S]+id=\$1[\s\S]+user_id=\$2/),
      [CLAIMED_SESSION_ID, USER_ID],
    );
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
  });

  it('keeps close claimed when token deletion reports a live mismatched row after acceptance', async () => {
    const fake = closeDeps(closeSession({ subject: 'Synthetic subject' }));
    const query = fake.deps.query.getMockImplementation();
    fake.deps.query.mockImplementation((sql, params) => (
      sql.includes('FROM compose_sessions')
        ? { rows: [{ operation_state: 'closing', operation_token: 'different-token' }] }
        : query(sql, params)
    ));
    fake.deps.deleteClaimedComposeSession.mockResolvedValueOnce(false);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_close_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ['empty new', closeSession()],
    ['unchanged source', (() => {
      const initial = closeSession({
        sourceDraftAccountId: ACCOUNT_ID,
        sourceDraftFolder: '[Synthetic]/Drafts',
        sourceDraftUid: 41,
      });
      return { ...initial, sourceInitialRevision: canonicalCompose(initial) };
    })()],
  ])('safely releases %s close when token deletion fails before any external acceptance', async (
    _label,
    session,
  ) => {
    const fake = closeDeps(session);
    const failure = new Error('Synthetic token deletion failure');
    fake.deps.deleteClaimedComposeSession.mockRejectedValueOnce(failure);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toBe(failure);
    expect(fake.deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledOnce();
  });

  it('normalizes an exposed missing-Drafts error, releases the claim, and emits no terminal success', async () => {
    const fake = closeDeps(closeSession({ subject: 'Synthetic subject' }));
    fake.deps.draftService.saveDraft.mockRejectedValueOnce(Object.assign(
      new Error('No Drafts folder found for this account'),
      { status: 422, expose: true },
    ));

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_drafts_folder_not_found',
      message: 'No Drafts folder is available for this account',
      status: 422,
      expose: true,
    });
    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledOnce();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).toHaveBeenCalledTimes(1);
    expect(fake.deps.broadcast.mock.calls[0][0].action).toBe('operation_released');
  });

  it.each([
    ['already-coded exposed', Object.assign(new Error('Synthetic coded failure'), {
      code: 'synthetic_coded', status: 409, expose: true,
    })],
    ['unknown non-exposed', new Error('Synthetic unknown failure')],
  ])('preserves the original %s draft error while releasing the claim', async (_label, failure) => {
    const fake = closeDeps(closeSession({ subject: 'Synthetic subject' }));
    fake.deps.draftService.saveDraft.mockRejectedValueOnce(failure);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toBe(failure);
    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledOnce();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
  });

  it('releases the exact token and preserves the session when draft save fails', async () => {
    const fake = closeDeps(closeSession({ subject: 'Synthetic subject' }));
    const failure = Object.assign(new Error('Synthetic save failure'), { code: 'synthetic_save' });
    fake.deps.draftService.saveDraft.mockRejectedValueOnce(failure);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toBe(failure);

    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).toHaveBeenCalledWith({
      type: 'compose_sessions_updated',
      action: 'operation_released',
      sessionId: CLAIMED_SESSION_ID,
      slot: 3,
      revision: 7,
    }, USER_ID);
  });

  it('performs no external or token calls when the atomic claim conflicts', async () => {
    const fake = closeDeps();
    const conflict = Object.assign(new Error('Synthetic conflict'), {
      code: 'compose_conflict', status: 409, expose: true,
    });
    fake.deps.claimComposeOperation.mockRejectedValueOnce(conflict);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 6,
      changes: { subject: 'Conflicting synthetic subject' },
    }, fake.deps)).rejects.toBe(conflict);

    expect(fake.deps.query).not.toHaveBeenCalled();
    expect(fake.deps.imapManager.fetchAttachment).not.toHaveBeenCalled();
    expect(fake.deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
  });

  it('owner-scopes and materializes forwarded attachment bytes before saveDraft', async () => {
    const forwardedMessageId = '00000000-0000-4000-8000-000000000030';
    const referencedAccount = { id: ACCOUNT_ID, email_address: 'sender@example.com' };
    const fake = closeDeps(closeSession({
      forwardedAttachments: [{ messageId: forwardedMessageId, part: '2' }],
    }));
    fake.deps.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts')) return { rows: [fake.account] };
      if (sql.includes('FROM messages')) {
        expect(params).toEqual([forwardedMessageId, USER_ID]);
        return { rows: [{
          uid: 91,
          folder: '[Synthetic]/Inbox',
          attachments: [{ part: '2', filename: 'forwarded.txt', type: 'text/plain' }],
          account: referencedAccount,
        }] };
      }
      throw new Error('Unexpected forwarded SQL');
    });
    fake.deps.imapManager.fetchAttachment.mockResolvedValueOnce(Buffer.from('forwarded bytes'));

    await closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps);

    expect(fake.deps.query).toHaveBeenCalledWith(
      expect.stringMatching(/JOIN email_accounts[\s\S]+a\.user_id\s*=\s*\$2/),
      [forwardedMessageId, USER_ID],
    );
    expect(fake.deps.imapManager.fetchAttachment).toHaveBeenCalledWith(
      referencedAccount, 91, '[Synthetic]/Inbox', '2',
    );
    const draftInput = fake.deps.draftService.saveDraft.mock.calls[0][0];
    expect(draftInput.forwardedAttachments).toEqual([]);
    expect(draftInput.attachments).toEqual([{
      filename: 'forwarded.txt',
      content: Buffer.from('forwarded bytes').toString('base64'),
      contentType: 'text/plain',
    }]);
  });

  it.each([
    ['foreign reference', { rows: [] }, Buffer.from('unused')],
    ['missing bytes', { rows: [{
      uid: 91,
      folder: '[Synthetic]/Inbox',
      attachments: [{ part: '2', filename: 'forwarded.txt', type: 'text/plain' }],
      account: { id: ACCOUNT_ID },
    }] }, null],
  ])('releases and preserves the session for %s', async (_label, messageResult, content) => {
    const fake = closeDeps(closeSession({
      forwardedAttachments: [{ messageId: MESSAGE_ID, part: '2' }],
    }));
    fake.deps.query.mockImplementation(async (sql) => (
      sql.includes('FROM email_accounts') ? { rows: [fake.account] } : messageResult
    ));
    fake.deps.imapManager.fetchAttachment.mockResolvedValueOnce(content);

    await expect(closeComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      changes: {},
    }, fake.deps)).rejects.toMatchObject({ expose: true });
    expect(fake.deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
  });
});

describe('sendComposeSession', () => {
  it.each([
    ['account', sendSession({ accountId: null }), 'compose_account_required'],
    ['recipient', sendSession({ to: [], cc: [], bcc: [] }), 'compose_recipients_required'],
  ])('releases a claimed session with a missing %s before external send', async (
    _label,
    session,
    code,
  ) => {
    const fake = sendDeps(session);

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toMatchObject({ code, status: 400, expose: true });

    expect(fake.deps.claimComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      operation: 'sending',
      changes: {},
    }, fake.deps);
    expect(fake.deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
    expect(fake.deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operation_released' }),
      USER_ID,
    );
  });

  it('performs zero account, send, cleanup, or token calls when the claim conflicts', async () => {
    const fake = sendDeps();
    const conflict = Object.assign(new Error('Compose session changed'), {
      code: 'compose_conflict', status: 409, expose: true,
    });
    fake.deps.claimComposeOperation.mockRejectedValueOnce(conflict);

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 6,
      idempotencyKey: 'synthetic-send-key',
    }, fake.deps)).rejects.toBe(conflict);

    expect(fake.deps.query).not.toHaveBeenCalled();
    expect(fake.deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
  });

  it('preserves the complete immediate receipt and deletes the token only after accepted delivery', async () => {
    const fake = sendDeps();
    const delivered = deferred();
    const result = {
      ok: true,
      messageId: '<sent-synthetic@example.com>',
      sentCopySaved: false,
      receipt: {
        subject: 'Synthetic send subject',
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      },
    };
    fake.deps.sendService.sendOrEnqueue.mockReturnValueOnce(delivered.promise);

    const sending = sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps);
    await vi.waitFor(() => expect(fake.deps.sendService.sendOrEnqueue).toHaveBeenCalledOnce());
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();

    delivered.resolve(result);
    await expect(sending).resolves.toBe(result);
    expect(fake.deps.outboxService.normalizeUndoWindow).toHaveBeenCalledWith(undefined, 0);
    expect(fake.deps.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        account: fake.destinationAccount,
        to: ['Recipient <recipient@example.com>'],
        subject: 'Synthetic send subject',
        body: 'Synthetic send body',
        bodyIsHtml: false,
        plaintextEmail: true,
        undoSeconds: 0,
        idempotencyKey: `compose-session:${CLAIMED_SESSION_ID}`,
      }),
      fake.deps,
    );
    expect(fake.deps.deleteClaimedComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
    expect(fake.deps.sendService.sendOrEnqueue.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0]);
    expect(fake.deps.broadcast).toHaveBeenCalledWith({
      type: 'compose_sessions_updated',
      action: 'sent',
      sessionId: CLAIMED_SESSION_ID,
      slot: 3,
      revision: 7,
    }, USER_ID);
  });

  it('durably enqueues with caller idempotency, source cleanup metadata, and no immediate draft delete', async () => {
    const session = sendSession({
      accountId: DESTINATION_ACCOUNT_ID,
      mode: 'reply',
      replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
      attachments: [{
        id: '66666666-6666-4666-8666-666666666666',
        filename: 'synthetic.txt',
        contentType: 'text/plain',
        byteCount: 12,
        content: Buffer.from('server bytes'),
      }],
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      sourceDraftMessageId: '<draft@example.com>',
      sourceInitialRevision: { subject: 'Synthetic source' },
    });
    const fake = sendDeps(session, { preference: 30 });
    const result = {
      queued: true,
      outboxId: '00000000-0000-4000-8000-000000000030',
      sendAt: new Date('2026-08-01T12:00:30.000Z'),
      undoSeconds: 30,
    };
    fake.deps.sendService.sendOrEnqueue.mockResolvedValueOnce(result);
    const callerKey = 'k'.repeat(128);

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      idempotencyKey: callerKey,
    }, fake.deps)).resolves.toBe(result);

    expect(fake.deps.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        account: fake.destinationAccount,
        undoSeconds: 30,
        idempotencyKey: expect.stringMatching(
          new RegExp(`^compose-session:${CLAIMED_SESSION_ID}:[a-f0-9]{64}$`),
        ),
        deleteDraftOnSend: {
          accountId: ACCOUNT_ID,
          uid: 41,
          folder: '[Synthetic]/Drafts',
        },
        composeSessionRestore: {
          version: 1,
          originalSessionId: CLAIMED_SESSION_ID,
          preferredSlot: 3,
          changes: expect.objectContaining({
            mode: 'reply',
            subject: 'Synthetic send subject',
          }),
          replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
          sourceDraft: {
            accountId: ACCOUNT_ID,
            folder: '[Synthetic]/Drafts',
            uid: 41,
            messageId: '<draft@example.com>',
            initialRevision: { subject: 'Synthetic source' },
          },
          attachments: [{
            id: '66666666-6666-4666-8666-666666666666',
            filename: 'synthetic.txt',
            contentType: 'text/plain',
            byteCount: 12,
            contentSha256: '6fac1c9e222157d1baa07e669d6df5b6be7177dc362306c79acfc2c6f31dfd0b',
          }],
        },
      }),
      fake.deps,
    );
    expect(fake.deps.sendService.sendOrEnqueue.mock.calls[0][0].idempotencyKey)
      .not.toContain(callerKey);
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).toHaveBeenCalledOnce();
    expect(fake.deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'queued' }),
      USER_ID,
    );
  });

  it('derives stable per-session keys at immediate and queued send boundaries', async () => {
    const callerKey = 'synthetic-shared-key';
    const firstImmediate = sendDeps(sendSession({ id: CLAIMED_SESSION_ID }));
    const repeatedImmediate = sendDeps(sendSession({ id: CLAIMED_SESSION_ID }));
    const secondQueued = sendDeps(sendSession({ id: SECOND_SESSION_ID }));
    secondQueued.deps.sendService.sendOrEnqueue.mockResolvedValueOnce({
      queued: true,
      outboxId: '00000000-0000-4000-8000-000000000030',
    });

    await sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      idempotencyKey: callerKey,
    }, firstImmediate.deps);
    await sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      idempotencyKey: callerKey,
    }, repeatedImmediate.deps);
    await sendComposeSession({
      userId: USER_ID,
      id: SECOND_SESSION_ID,
      expectedRevision: 7,
      idempotencyKey: callerKey,
    }, secondQueued.deps);

    const firstKey = firstImmediate.deps.sendService.sendOrEnqueue.mock.calls[0][0].idempotencyKey;
    const repeatedKey = repeatedImmediate.deps.sendService.sendOrEnqueue.mock.calls[0][0].idempotencyKey;
    const secondKey = secondQueued.deps.sendService.sendOrEnqueue.mock.calls[0][0].idempotencyKey;
    expect(firstKey).toBe(repeatedKey);
    expect(secondKey).not.toBe(firstKey);
    expect(firstKey).toMatch(
      new RegExp(`^compose-session:${CLAIMED_SESSION_ID}:[a-f0-9]{64}$`),
    );
    expect(secondKey).toMatch(
      new RegExp(`^compose-session:${SECOND_SESSION_ID}:[a-f0-9]{64}$`),
    );
    expect(firstKey.length).toBeLessThanOrEqual(128);
    expect(secondKey.length).toBeLessThanOrEqual(128);
    expect(firstKey).not.toContain(callerKey);
    expect(secondKey).not.toContain(callerKey);
  });

  it('deletes a claimed source through its owner only after immediate acceptance', async () => {
    const session = sendSession({
      accountId: DESTINATION_ACCOUNT_ID,
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
    });
    const fake = sendDeps(session);
    const delivered = deferred();
    fake.deps.sendService.sendOrEnqueue.mockReturnValueOnce(delivered.promise);

    const sending = sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      idempotencyKey: 'synthetic-source-send',
    }, fake.deps);
    await vi.waitFor(() => expect(fake.deps.sendService.sendOrEnqueue).toHaveBeenCalledOnce());
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();

    delivered.resolve({ ok: true, receipt: { subject: 'Synthetic send subject' } });
    await sending;
    expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledWith({
      account: fake.sourceAccount,
      uid: 41,
      folder: '[Synthetic]/Drafts',
    }, fake.deps);
    expect(fake.deps.sendService.sendOrEnqueue.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.draftService.deleteDraft.mock.invocationCallOrder[0]);
    expect(fake.deps.draftService.deleteDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0]);
  });

  it('releases SMTP, outbox, and malformed acceptance failures without deleting the session', async () => {
    const failures = [
      Object.assign(new Error('Synthetic SMTP failure'), { code: 'synthetic_smtp' }),
      Object.assign(new Error('Synthetic outbox failure'), { code: 'synthetic_outbox' }),
    ];
    for (const failure of failures) {
      const fake = sendDeps();
      fake.deps.sendService.sendOrEnqueue.mockRejectedValueOnce(failure);
      await expect(sendComposeSession({
        userId: USER_ID,
        id: CLAIMED_SESSION_ID,
        expectedRevision: 7,
      }, fake.deps)).rejects.toBe(failure);
      expect(fake.deps.releaseComposeOperation).toHaveBeenCalledOnce();
      expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    }

    const malformed = sendDeps();
    malformed.deps.sendService.sendOrEnqueue.mockResolvedValueOnce({ queued: true });
    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, malformed.deps)).rejects.toMatchObject({
      code: 'compose_send_unaccepted',
      status: 500,
      expose: false,
    });
    expect(malformed.deps.releaseComposeOperation).toHaveBeenCalledOnce();
    expect(malformed.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();

    const ambiguous = sendDeps();
    ambiguous.deps.sendService.sendOrEnqueue.mockResolvedValueOnce({
      ok: true,
      queued: true,
      outboxId: '00000000-0000-4000-8000-000000000030',
    });
    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, ambiguous.deps)).rejects.toMatchObject({
      code: 'compose_send_unaccepted',
      status: 500,
      expose: false,
    });
    expect(ambiguous.deps.releaseComposeOperation).toHaveBeenCalledOnce();
    expect(ambiguous.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
  });

  it('treats immediate source cleanup as best effort after acceptance and never sends twice', async () => {
    const session = sendSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
    });
    const fake = sendDeps(session);
    const accepted = {
      ok: true,
      messageId: '<accepted-synthetic@example.com>',
      receipt: { subject: 'Synthetic send subject' },
    };
    const alreadyTerminal = Object.assign(new Error('Compose session not found'), {
      code: 'compose_session_not_found', status: 404, expose: true,
    });
    fake.deps.claimComposeOperation
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(alreadyTerminal);
    fake.deps.sendService.sendOrEnqueue.mockResolvedValue(accepted);
    fake.deps.draftService.deleteDraft.mockRejectedValueOnce(Object.assign(
      new Error('Synthetic cleanup failure with private diagnostics'),
      { code: 'synthetic_cleanup' },
    ));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = {
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      idempotencyKey: 'caller-stable-key',
    };

    await expect(sendComposeSession(input, fake.deps)).resolves.toBe(accepted);
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      'Compose source cleanup failed after accepted send',
      { code: 'synthetic_cleanup' },
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private diagnostics');

    await expect(sendComposeSession(input, fake.deps)).rejects.toBe(alreadyTerminal);
    expect(fake.deps.sendService.sendOrEnqueue).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it('keeps an accepted send claimed when terminal token deletion throws and blocks resend', async () => {
    const session = sendSession();
    const fake = sendDeps(session);
    const operationInProgress = Object.assign(new Error('Operation in progress'), {
      code: 'compose_operation_in_progress', status: 409, expose: true,
    });
    fake.deps.claimComposeOperation
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(operationInProgress);
    fake.deps.deleteClaimedComposeSession.mockRejectedValueOnce(
      new Error('Synthetic database disconnect with private diagnostics'),
    );

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_send_accepted_cleanup_pending',
      status: 500,
      expose: false,
      message: 'The message was accepted but compose cleanup is still pending',
    });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toBe(operationInProgress);
    expect(fake.deps.sendService.sendOrEnqueue).toHaveBeenCalledOnce();
  });

  it('treats an already-absent row as idempotent terminal cleanup after acceptance', async () => {
    const fake = sendDeps();
    const query = fake.deps.query.getMockImplementation();
    fake.deps.query.mockImplementation((sql, params) => (
      sql.includes('FROM compose_sessions') ? { rows: [] } : query(sql, params)
    ));
    fake.deps.deleteClaimedComposeSession.mockResolvedValueOnce(false);

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).resolves.toMatchObject({ ok: true });
    expect(fake.deps.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM compose_sessions[\s\S]+id=\$1[\s\S]+user_id=\$2/),
      [CLAIMED_SESSION_ID, USER_ID],
    );
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sent' }),
      USER_ID,
    );
  });

  it('fails closed without release when a mismatched live claim remains after acceptance', async () => {
    const fake = sendDeps();
    const query = fake.deps.query.getMockImplementation();
    fake.deps.query.mockImplementation((sql, params) => (
      sql.includes('FROM compose_sessions')
        ? { rows: [{ operation_state: 'sending', operation_token: 'different-token' }] }
        : query(sql, params)
    ));
    fake.deps.deleteClaimedComposeSession.mockResolvedValueOnce(false);

    await expect(sendComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_send_accepted_cleanup_pending',
      expose: false,
    });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
  });

  it('rejects distinct overlong same-prefix idempotency keys without sending or deleting', async () => {
    const fake = sendDeps();
    const prefix = 'same-prefix-'.padEnd(128, 'x');

    for (const key of [`${prefix}a`, `${prefix}b`]) {
      await expect(sendComposeSession({
        userId: USER_ID,
        id: CLAIMED_SESSION_ID,
        expectedRevision: 7,
        idempotencyKey: key,
      }, fake.deps)).rejects.toMatchObject({
        code: 'invalid_compose_idempotency_key',
        status: 400,
        expose: true,
      });
    }

    expect(fake.deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledTimes(2);
  });

  it.each(['', '   ', 'key\nvalue', 'recipient@example.com', 'key/with/content'])(
    'rejects unsafe idempotency key %# and releases before send',
    async (idempotencyKey) => {
      const fake = sendDeps();

      await expect(sendComposeSession({
        userId: USER_ID,
        id: CLAIMED_SESSION_ID,
        expectedRevision: 7,
        idempotencyKey,
      }, fake.deps)).rejects.toMatchObject({
        code: 'invalid_compose_idempotency_key',
        status: 400,
        expose: true,
      });
      expect(fake.deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
      expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
      expect(fake.deps.releaseComposeOperation).toHaveBeenCalledOnce();
    },
  );
});

describe('discardComposeSession', () => {
  it('claims discarding and deletes a new session by the exact token', async () => {
    const fake = closeDeps(closeSession({ operationState: 'discarding' }));

    await expect(discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).resolves.toEqual({ discarded: true, slot: 3 });

    expect(fake.deps.claimComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
      operation: 'discarding',
      changes: {},
    }, fake.deps);
    expect(fake.deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(fake.deps.deleteClaimedComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
    expect(fake.deps.broadcast).toHaveBeenCalledWith({
      type: 'compose_sessions_updated',
      action: 'discarded',
      sessionId: CLAIMED_SESSION_ID,
      slot: 3,
      revision: 7,
    }, USER_ID);
  });

  it('awaits source deletion through its owner-scoped account before token deletion', async () => {
    const fake = closeDeps(closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    }));
    const deletion = deferred();
    fake.deps.draftService.deleteDraft.mockReturnValueOnce(deletion.promise);

    const discarding = discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps);
    await vi.waitFor(() => expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledOnce());
    expect(fake.deps.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM email_accounts[\s\S]+id=\$1[\s\S]+user_id=\$2/),
      [ACCOUNT_ID, USER_ID],
    );
    expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledWith({
      account: fake.account,
      uid: 41,
      folder: '[Synthetic]/Drafts',
      reportDeletionAcceptance: true,
    }, fake.deps);
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();

    deletion.resolve({ ok: true });
    await discarding;
    expect(fake.deps.draftService.deleteDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fake.deps.deleteClaimedComposeSession.mock.invocationCallOrder[0]);
  });

  it('releases a failed source deletion and preserves the session', async () => {
    const fake = closeDeps(closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    }));
    const failure = Object.assign(new Error('Synthetic delete failure'), {
      code: 'synthetic_delete',
    });
    fake.deps.draftService.deleteDraft.mockRejectedValueOnce(failure);

    await expect(discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toBe(failure);

    expect(fake.deps.releaseComposeOperation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      token: '00000000-0000-4000-8000-000000000020',
    }, fake.deps);
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operation_released' }),
      USER_ID,
    );
  });

  it('blocks discard retry when token deletion fails after source deletion was accepted', async () => {
    const session = closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    });
    const fake = closeDeps(session);
    const operationInProgress = Object.assign(new Error('Operation in progress'), {
      code: 'compose_operation_in_progress', status: 409, expose: true,
    });
    fake.deps.claimComposeOperation
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(operationInProgress);
    fake.deps.deleteClaimedComposeSession.mockRejectedValueOnce(
      new Error('Synthetic database disconnect'),
    );
    const input = {
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    };

    await expect(discardComposeSession(input, fake.deps)).rejects.toMatchObject({
      code: 'compose_discard_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();

    await expect(discardComposeSession(input, fake.deps)).rejects.toBe(operationInProgress);
    expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledOnce();
  });

  it('treats an owner-scoped absent row as completed discard cleanup after source deletion', async () => {
    const fake = closeDeps(closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    }));
    const query = fake.deps.query.getMockImplementation();
    fake.deps.query.mockImplementation((sql, params) => (
      sql.includes('FROM compose_sessions') ? { rows: [] } : query(sql, params)
    ));
    fake.deps.deleteClaimedComposeSession.mockResolvedValueOnce(false);

    await expect(discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).resolves.toEqual({ discarded: true, slot: 3 });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
  });

  it('keeps discard claimed when token deletion reports a live row after source deletion', async () => {
    const fake = closeDeps(closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    }));
    const query = fake.deps.query.getMockImplementation();
    fake.deps.query.mockImplementation((sql, params) => (
      sql.includes('FROM compose_sessions')
        ? { rows: [{ operation_state: 'discarding', operation_token: 'different-token' }] }
        : query(sql, params)
    ));
    fake.deps.deleteClaimedComposeSession.mockResolvedValueOnce(false);

    await expect(discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_discard_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
  });

  it('keeps discard claimed when IMAP deletion succeeded but local source cleanup is pending', async () => {
    const fake = closeDeps(closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    }));
    fake.deps.draftService.deleteDraft.mockResolvedValueOnce({
      ok: true,
      localCleanupPending: true,
    });

    await expect(discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_discard_accepted_cleanup_pending',
      status: 409,
      expose: true,
    });
    expect(fake.deps.draftService.deleteDraft).toHaveBeenCalledWith({
      account: fake.account,
      uid: 41,
      folder: '[Synthetic]/Drafts',
      reportDeletionAcceptance: true,
    }, fake.deps);
    expect(fake.deps.deleteClaimedComposeSession).not.toHaveBeenCalled();
    expect(fake.deps.releaseComposeOperation).not.toHaveBeenCalled();
  });

  it('preserves the original external error when release also fails', async () => {
    const fake = closeDeps(closeSession({
      sourceDraftAccountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      operationState: 'discarding',
    }));
    const original = Object.assign(new Error('Synthetic original failure'), {
      code: 'synthetic_original',
    });
    fake.deps.draftService.deleteDraft.mockRejectedValueOnce(original);
    fake.deps.releaseComposeOperation.mockRejectedValueOnce(Object.assign(
      new Error('Synthetic release failure'),
      { code: 'synthetic_release' },
    ));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(discardComposeSession({
      userId: USER_ID,
      id: CLAIMED_SESSION_ID,
      expectedRevision: 7,
    }, fake.deps)).rejects.toBe(original);

    expect(errorLog).toHaveBeenCalledWith('Compose session operation release failed', {
      originalCode: 'synthetic_original',
      releaseCode: 'synthetic_release',
    });
    expect(fake.deps.broadcast).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
