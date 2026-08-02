import { describe, expect, it, vi } from 'vitest';
import { restoreQueuedComposeSession } from './composeSessionService.js';
import { enqueue } from './outboxService.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OUTBOX_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const ATTACHMENT_ID = '55555555-5555-4555-8555-555555555555';

function restorePayload() {
  const payload = {
    version: 1,
    originalSessionId: SESSION_ID,
    preferredSlot: 3,
    changes: {
      accountId: ACCOUNT_ID,
      aliasId: null,
      mode: 'reply',
      to: ['Synthetic Recipient <recipient@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Synthetic subject',
      body: 'Synthetic body',
      bodyIsHtml: false,
      quotedBody: null,
      quotedBodyHtml: null,
      editedSignature: null,
      forwardedAttachments: [],
      priority: 'normal',
      inReplyTo: '<source@example.com>',
      references: ['<source@example.com>'],
      fromChanged: false,
    },
    replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
    sourceDraft: {
      accountId: ACCOUNT_ID,
      folder: 'Drafts',
      uid: 7,
      messageId: '<draft@example.com>',
      initialRevision: null,
    },
    attachments: [{
      id: ATTACHMENT_ID,
      filename: 'synthetic.txt',
      contentType: 'text/plain',
      byteCount: 12,
      contentSha256: '6fac1c9e222157d1baa07e669d6df5b6be7177dc362306c79acfc2c6f31dfd0b',
    }],
  };
  payload.sourceDraft.initialRevision = {
    ...structuredClone(payload.changes),
    attachments: [{
      id: ATTACHMENT_ID,
      filename: 'synthetic.txt',
      contentType: 'text/plain',
      byteCount: 12,
    }],
  };
  return payload;
}

function fakeDependencies({ occupiedSlots = [] } = {}) {
  const state = {
    outbox: {
      id: OUTBOX_ID,
      user_id: USER_ID,
      status: 'pending',
      payload: {
        composeSessionRestore: restorePayload(),
        attachments: [{
          filename: 'synthetic.txt',
          contentType: 'text/plain',
          content: Buffer.from('server bytes').toString('base64'),
        }],
      },
      restored_compose_session_id: null,
      idempotency_key: 'compose-session-original',
    },
    sessions: occupiedSlots.map((slot, index) => ({
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      user_id: USER_ID,
      slot,
    })),
    attachments: [],
  };
  let lock = Promise.resolve();

  const query = vi.fn(async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.includes('FROM outbox_messages') && normalized.includes('FOR UPDATE')) {
      const [id, userId] = params;
      return { rows: state.outbox.id === id && state.outbox.user_id === userId
        ? [{ ...state.outbox }]
        : [] };
    }
    if (normalized.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (normalized.includes('FROM email_accounts')) {
      const [accountId, userId] = params;
      return { rows: accountId === ACCOUNT_ID && userId === USER_ID ? [{ id: ACCOUNT_ID }] : [] };
    }
    if (normalized.includes('generate_series(1, 9)')) {
      const [, preferredSlot] = params;
      const occupied = new Set(state.sessions.map(row => row.slot));
      const candidates = [preferredSlot, ...Array.from({ length: 9 }, (_, index) => index + 1)]
        .filter((slot, index, all) => slot != null && all.indexOf(slot) === index);
      const slot = candidates.find(candidate => !occupied.has(candidate));
      return { rows: slot == null ? [] : [{ slot }] };
    }
    if (normalized.startsWith('INSERT INTO compose_sessions')) {
      const row = {
        id: params[0], user_id: params[1], slot: Number(params[2]),
        account_id: params[3], alias_id: params[4], mode: params[5],
        to_recipients: JSON.parse(params[6]), cc_recipients: JSON.parse(params[7]),
        bcc_recipients: JSON.parse(params[8]), subject: params[9], body: params[10],
        body_is_html: params[11], quoted_body: params[12], quoted_body_html: params[13],
        edited_signature: params[14], forwarded_attachments: JSON.parse(params[15]),
        priority: params[16], in_reply_to: params[17], thread_references: JSON.parse(params[18]),
        from_changed: params[19], reply_all_recipients: JSON.parse(params[20]),
        source_draft_account_id: params[21], source_draft_folder: params[22],
        source_draft_uid: params[23], source_draft_message_id: params[24],
        source_initial_revision: JSON.parse(params[25]), presentation_state: 'expanded',
        operation_state: 'idle', operation_token: null, revision: 1, field_revisions: '{}',
        last_focused_at: new Date('2026-08-01T00:00:00Z'),
        created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-01T00:00:00Z'),
      };
      state.sessions.push(row);
      return { rows: [{ ...row }] };
    }
    if (normalized.startsWith('INSERT INTO compose_session_attachments')) {
      const row = {
        id: params[0], session_id: params[1], filename: params[2], content_type: params[3],
        byte_count: params[4], content: Buffer.from(params[5]),
        created_at: new Date('2026-08-01T00:00:00Z'),
      };
      state.attachments.push(row);
      return { rows: [{ ...row }] };
    }
    if (normalized.startsWith('UPDATE outbox_messages')) {
      state.outbox.status = 'cancelled';
      state.outbox.payload = {};
      state.outbox.restored_compose_session_id = params[2];
      if (normalized.includes('idempotency_key=NULL')) state.outbox.idempotency_key = null;
      return { rows: [{ id: state.outbox.id }] };
    }
    if (normalized.startsWith('INSERT INTO outbox_messages')) {
      const [userId, accountId, payload, , , , , idempotencyKey] = params;
      const existing = [state.outbox, state.newOutbox].find(row => (
        row?.user_id === userId && row.idempotency_key === idempotencyKey && idempotencyKey != null
      ));
      if (existing) return { rows: [{ id: existing.id, send_at: existing.send_at }] };
      state.newOutbox = {
        id: '77777777-7777-4777-8777-777777777777',
        user_id: userId,
        account_id: accountId,
        payload,
        status: 'pending',
        send_at: new Date('2026-08-01T00:00:30Z'),
        idempotency_key: idempotencyKey,
      };
      return { rows: [{ id: state.newOutbox.id, send_at: state.newOutbox.send_at }] };
    }
    if (normalized.startsWith('SELECT * FROM compose_sessions')) {
      const [id, userId] = params;
      const row = state.sessions.find(item => item.id === id && item.user_id === userId);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (normalized.includes('FROM compose_session_attachments')) {
      return { rows: state.attachments
        .filter(item => item.session_id === params[0])
        .map(item => ({
          id: item.id,
          session_id: item.session_id,
          filename: item.filename,
          content_type: item.content_type,
          byte_count: item.byte_count,
          created_at: item.created_at,
        })) };
    }
    throw new Error(`Unexpected restore SQL: ${normalized}`);
  });

  const withTransaction = async (callback) => {
    let release;
    const prior = lock;
    lock = new Promise(resolve => { release = resolve; });
    await prior;
    const snapshot = structuredClone(state);
    try {
      return await callback({ query });
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    } finally {
      release();
    }
  };

  async function claimWorker() {
    return withTransaction(async (client) => {
      const selected = await client.query(
        'SELECT * FROM outbox_messages WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [OUTBOX_ID, USER_ID],
      );
      if (selected.rows[0]?.status !== 'pending') return false;
      state.outbox.status = 'claimed';
      return true;
    });
  }

  return { deps: { withTransaction, broadcast: vi.fn() }, state, claimWorker };
}

describe('restoreQueuedComposeSession', () => {
  it('atomically restores attachments, wipes private payload, and replays without duplication', async () => {
    const fake = fakeDependencies();

    const first = await restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps);
    const replay = await restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps);

    expect(first).toMatchObject({ restored: true, replayed: false, session: {
      id: SESSION_ID, slot: 3,
      replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
      attachments: [{ id: ATTACHMENT_ID, filename: 'synthetic.txt', byteCount: 12 }],
    } });
    expect(first.session.attachments[0]).not.toHaveProperty('content');
    expect(replay).toMatchObject({ restored: true, replayed: true, session: { id: SESSION_ID } });
    expect(fake.state.sessions.filter(row => row.id === SESSION_ID)).toHaveLength(1);
    expect(fake.state.attachments[0].content.equals(Buffer.from('server bytes'))).toBe(true);
    expect(fake.state.outbox).toMatchObject({
      status: 'cancelled', payload: {}, restored_compose_session_id: SESSION_ID,
    });
  });

  it('rotates the restored send key so retry enqueue creates one new pending delivery', async () => {
    const fake = fakeDependencies();
    await restoreQueuedComposeSession({ userId: USER_ID, outboxId: OUTBOX_ID }, fake.deps);
    expect(fake.state.outbox.idempotency_key).toBeNull();
    const enqueueDeps = {
      query: (...args) => fake.deps.withTransaction(client => client.query(...args)),
    };
    const input = {
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      payload: { subject: 'New pending delivery' },
      undoSeconds: 30,
      idempotencyKey: 'compose-session-original',
      subject: 'New pending delivery',
      toPreview: ['recipient@example.com'],
      messageId: '<new@example.com>',
    };
    const [first, retry] = await Promise.all([
      enqueue(input, enqueueDeps),
      enqueue(input, enqueueDeps),
    ]);
    expect(first.outbox_id).toBe('77777777-7777-4777-8777-777777777777');
    expect(retry.outbox_id).toBe(first.outbox_id);
    expect(fake.state.newOutbox).toMatchObject({
      status: 'pending',
      payload: expect.objectContaining({ subject: 'New pending delivery' }),
      idempotency_key: 'compose-session-original',
    });
    expect(fake.state.outbox).toMatchObject({ status: 'cancelled', payload: {} });
    await expect(restoreQueuedComposeSession({ userId: USER_ID, outboxId: OUTBOX_ID }, fake.deps))
      .resolves.toMatchObject({ restored: true, replayed: true, session: { id: SESSION_ID } });
  });

  it('rolls back without cancelling or clearing when all nine slots are full', async () => {
    const fake = fakeDependencies({ occupiedSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'compose_session_limit', status: 409 });
    expect(fake.state.outbox.status).toBe('pending');
    expect(fake.state.outbox.payload.attachments[0].content).toBeTruthy();
    expect(fake.state.sessions).toHaveLength(9);
  });

  it('uses the deterministic lowest free slot when the preferred slot is occupied', async () => {
    const fake = fakeDependencies({ occupiedSlots: [1, 3] });
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).resolves.toMatchObject({ session: { slot: 2 } });
  });

  it('rejects corrupt attachment content without clearing the pending payload', async () => {
    const fake = fakeDependencies();
    fake.state.outbox.payload.attachments[0].content = 'not base64';
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'invalid_compose_restore_payload', status: 409 });
    expect(fake.state.outbox.status).toBe('pending');
    expect(fake.state.sessions).toHaveLength(0);
  });

  it.each([
    ['truncated', Buffer.from('server byte')],
    ['expanded', Buffer.from('server bytes!')],
  ])('rejects %s uploaded bytes when the canonical descriptor size is unchanged', async (
    _label,
    content,
  ) => {
    const fake = fakeDependencies();
    fake.state.outbox.payload.composeSessionRestore.sourceDraft = null;
    fake.state.outbox.payload.attachments[0].content = content.toString('base64');
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'invalid_compose_restore_payload', status: 409 });
    expect(fake.state.outbox).toMatchObject({
      status: 'pending',
      idempotency_key: 'compose-session-original',
      restored_compose_session_id: null,
    });
    expect(fake.state.outbox.payload).not.toEqual({});
    expect(fake.state.sessions).toHaveLength(0);
  });

  it('rejects same-length substituted bytes without mutating the pending outbox row', async () => {
    const fake = fakeDependencies();
    fake.state.outbox.payload.composeSessionRestore.sourceDraft = null;
    fake.state.outbox.payload.attachments[0].content = Buffer.from('server bytez')
      .toString('base64');
    const pendingBeforeRestore = structuredClone(fake.state.outbox);

    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'invalid_compose_restore_payload', status: 409 });

    expect(fake.state.outbox).toEqual(pendingBeforeRestore);
    expect(fake.state.sessions).toHaveLength(0);
    expect(fake.state.attachments).toHaveLength(0);
  });

  it('restores mixed source and later uploaded attachments with exact byte counts', async () => {
    const fake = fakeDependencies();
    const uploadedId = '88888888-8888-4888-8888-888888888888';
    fake.state.outbox.payload.composeSessionRestore.attachments.push({
      id: uploadedId,
      filename: 'later.txt',
      contentType: 'text/plain',
      byteCount: 5,
      contentSha256: '1d9283d848ea941ace1fe0d2378ef8b70056a0d4d1648b95a322d90163e78285',
    });
    fake.state.outbox.payload.attachments.push({
      filename: 'later.txt',
      contentType: 'text/plain',
      content: Buffer.from('later').toString('base64'),
    });

    const result = await restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps);

    expect(result.session.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ATTACHMENT_ID, byteCount: 12 }),
      expect.objectContaining({ id: uploadedId, byteCount: 5 }),
    ]));
    expect(result.session.sourceInitialRevision.attachments).toEqual([
      expect.objectContaining({ id: ATTACHMENT_ID, byteCount: 12 }),
    ]);
  });

  it.each([
    ['missing version', capsule => { delete capsule.version; }],
    ['unknown key', capsule => { capsule.unexpected = true; }],
    ['missing canonical field', capsule => { delete capsule.changes.mode; }],
    ['unknown canonical field', capsule => { capsule.changes.unexpected = true; }],
    ['missing attachment byte count', capsule => { delete capsule.attachments[0].byteCount; }],
    ['missing attachment digest', capsule => { delete capsule.attachments[0].contentSha256; }],
    ['bad attachment digest', capsule => { capsule.attachments[0].contentSha256 = 'A'.repeat(64); }],
    ['unknown attachment field', capsule => { capsule.attachments[0].unexpected = true; }],
    ['unsafe attachment byte count', capsule => {
      capsule.attachments[0].byteCount = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['duplicate attachment ids', capsule => { capsule.attachments.push({ ...capsule.attachments[0] }); }],
    ['duplicate source attachment ids', capsule => {
      capsule.sourceDraft.initialRevision.attachments.push({
        ...capsule.sourceDraft.initialRevision.attachments[0],
      });
    }],
    ['invalid source attachment byte count', capsule => {
      capsule.sourceDraft.initialRevision.attachments[0].byteCount = -1;
    }],
    ['null sending account', capsule => { capsule.changes.accountId = null; }],
  ])('rejects exact-schema corruption: %s', async (_label, corrupt) => {
    const fake = fakeDependencies();
    corrupt(fake.state.outbox.payload.composeSessionRestore);
    if (fake.state.outbox.payload.composeSessionRestore.attachments.length > 1) {
      fake.state.outbox.payload.attachments.push({ ...fake.state.outbox.payload.attachments[0] });
    }
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'invalid_compose_restore_payload', status: 409 });
    expect(fake.state.outbox.status).toBe('pending');
    expect(fake.state.outbox.payload).not.toEqual({});
    expect(fake.state.sessions).toHaveLength(0);
  });

  it('revalidates the stored sending identity before restoring', async () => {
    const fake = fakeDependencies();
    fake.state.outbox.payload.composeSessionRestore.changes.accountId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'invalid_compose_restore_payload', status: 409 });
    expect(fake.state.outbox.status).toBe('pending');
  });

  it('has exactly one winner against worker claim on the locked outbox row', async () => {
    const fake = fakeDependencies();
    const [restored, claimed] = await Promise.all([
      restoreQueuedComposeSession({ userId: USER_ID, outboxId: OUTBOX_ID }, fake.deps)
        .then(() => true, () => false),
      fake.claimWorker(),
    ]);
    expect(Number(restored) + Number(claimed)).toBe(1);
  });

  it.each([
    ['claimed', 'compose_outbox_too_late', 409],
    ['sent', 'compose_outbox_too_late', 409],
    ['failed', 'compose_outbox_too_late', 409],
    ['cancelled', 'compose_outbox_cancelled', 409],
  ])('returns an explicit %s outcome', async (status, code, expectedStatus) => {
    const fake = fakeDependencies();
    fake.state.outbox.status = status;
    await expect(restoreQueuedComposeSession({
      userId: USER_ID, outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code, status: expectedStatus });
  });

  it('owner-scopes missing outbox rows', async () => {
    const fake = fakeDependencies();
    await expect(restoreQueuedComposeSession({
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outboxId: OUTBOX_ID,
    }, fake.deps)).rejects.toMatchObject({ code: 'compose_outbox_not_found', status: 404 });
  });
});
