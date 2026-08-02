import { describe, expect, it, vi } from 'vitest';
import {
  addComposeAttachment,
  claimComposeOperation,
  createComposeSession,
  deleteClaimedComposeSession,
  getComposeSession,
  listComposeSessions,
  patchComposeSession,
  releaseComposeOperation,
  removeComposeAttachment,
  setComposePresentation,
} from './composeSessionService.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_A2 = 'abababab-abab-4bab-8bab-abababababab';
const ACCOUNT_B = 'acacacac-acac-4cac-8cac-acacacacacac';
const ALIAS_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATED_AT = new Date('2026-08-01T00:00:00.000Z');
const ATTACHMENT_AT = new Date('2026-08-01T00:01:00.000Z');
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function parseJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function fakeDependencies() {
  const sessions = new Map();
  const attachments = [];
  const accountOwners = new Map([
    [ACCOUNT_A, USER_A],
    [ACCOUNT_A2, USER_A],
    [ACCOUNT_B, USER_B],
  ]);
  const aliasAccounts = new Map([[ALIAS_A, ACCOUNT_A]]);
  let nextSession = 1;
  let nextAttachment = 1;

  const query = vi.fn(async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.includes('pg_advisory_xact_lock')) return { rows: [{}] };

    if (normalized.includes('FROM account_aliases')) {
      const [aliasId, accountId, userId] = params;
      const valid = aliasAccounts.get(aliasId) === accountId
        && accountOwners.get(accountId) === userId;
      return { rows: valid ? [{ id: aliasId }] : [] };
    }

    if (normalized.includes('FROM email_accounts')) {
      const [accountId, userId] = params;
      return { rows: accountOwners.get(accountId) === userId ? [{ id: accountId }] : [] };
    }

    if (normalized.includes('generate_series(1, 9)')) {
      const [userId, requestedSlot] = params;
      const occupied = new Set(
        [...sessions.values()].filter(row => row.user_id === userId).map(row => row.slot),
      );
      const candidates = requestedSlot == null
        ? Array.from({ length: 9 }, (_, index) => index + 1)
        : [requestedSlot];
      const slot = candidates.find(candidate => !occupied.has(candidate));
      return { rows: slot == null ? [] : [{ slot }] };
    }

    if (normalized.startsWith('INSERT INTO compose_sessions')) {
      const [
        userId, slot, accountId, aliasId, mode, to, cc, bcc, subject, body,
        bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature, forwardedAttachments,
        priority, inReplyTo, references, fromChanged, fieldRevisions,
        replyAllRecipients,
      ] = params;
      const id = `00000000-0000-4000-8000-${String(nextSession++).padStart(12, '0')}`;
      const row = {
        id,
        user_id: userId,
        slot,
        account_id: accountId,
        alias_id: aliasId,
        mode,
        to_recipients: parseJson(to),
        cc_recipients: parseJson(cc),
        bcc_recipients: parseJson(bcc),
        subject,
        body,
        body_is_html: bodyIsHtml,
        quoted_body: quotedBody,
        quoted_body_html: quotedBodyHtml,
        edited_signature: editedSignature,
        forwarded_attachments: parseJson(forwardedAttachments),
        priority,
        in_reply_to: inReplyTo,
        thread_references: parseJson(references),
        from_changed: fromChanged,
        presentation_state: 'expanded',
        operation_state: 'idle',
        operation_token: null,
        revision: 1,
        field_revisions: parseJson(fieldRevisions),
        reply_all_recipients: parseJson(replyAllRecipients),
        last_focused_at: CREATED_AT,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      };
      sessions.set(id, row);
      return { rows: [{ ...row }] };
    }

    if (normalized.includes('FROM compose_sessions cs')
        && normalized.includes('attachment_count')) {
      const [userId] = params;
      const rows = [...sessions.values()]
        .filter(row => row.user_id === userId)
        .sort((left, right) => left.slot - right.slot)
        .map(row => ({
          id: row.id,
          slot: row.slot,
          account_id: row.account_id,
          alias_id: row.alias_id,
          mode: row.mode,
          subject: row.subject,
          priority: row.priority,
          presentation_state: row.presentation_state,
          operation_state: row.operation_state,
          revision: row.revision,
          last_focused_at: row.last_focused_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
          attachment_count: attachments.filter(item => item.session_id === row.id).length,
        }));
      return { rows };
    }

    if (normalized.startsWith('SELECT COUNT(*)')) {
      const [sessionId] = params;
      const matching = attachments.filter(item => item.session_id === sessionId);
      const totalBytes = matching
        .reduce((total, item) => total + item.byte_count, 0);
      return { rows: [{ attachment_count: matching.length, total_bytes: totalBytes }] };
    }

    if (normalized.startsWith('INSERT INTO compose_session_attachments')) {
      const [sessionId, filename, contentType, byteCount, content] = params;
      const id = `10000000-0000-4000-8000-${String(nextAttachment++).padStart(12, '0')}`;
      const row = {
        id,
        session_id: sessionId,
        filename,
        content_type: contentType,
        byte_count: byteCount,
        content,
        created_at: ATTACHMENT_AT,
      };
      attachments.push(row);
      return { rows: [{ ...row }] };
    }

    if (normalized.startsWith('DELETE FROM compose_session_attachments csa')) {
      const [attachmentId, sessionId, userId] = params;
      const session = sessions.get(sessionId);
      const index = attachments.findIndex(item => (
        item.id === attachmentId && item.session_id === sessionId
      ));
      if (!session || session.user_id !== userId || index < 0) return { rows: [] };
      const [deleted] = attachments.splice(index, 1);
      return { rows: [{ id: deleted.id }] };
    }

    if (normalized.startsWith('DELETE FROM compose_sessions')) {
      const whereMatch = normalized.match(
        /WHERE (id|slot)=\$(\d+) AND user_id=\$(\d+) AND operation_token=\$(\d+)/,
      );
      const locator = params[Number(whereMatch[2]) - 1];
      const userId = params[Number(whereMatch[3]) - 1];
      const token = params[Number(whereMatch[4]) - 1];
      const row = [...sessions.values()].find(candidate => (
        candidate.user_id === userId
        && candidate.operation_token === token
        && (whereMatch[1] === 'id' ? candidate.id === locator : candidate.slot === locator)
      ));
      if (!row) return { rows: [] };
      sessions.delete(row.id);
      return { rows: [{ id: row.id }] };
    }

    if (normalized.startsWith('SELECT id FROM compose_session_attachments')) {
      const [attachmentId, sessionId] = params;
      const attachment = attachments.find(item => (
        item.id === attachmentId && item.session_id === sessionId
      ));
      return { rows: attachment ? [{ id: attachment.id }] : [] };
    }

    if (normalized.includes('FROM compose_session_attachments')) {
      const [sessionId] = params;
      return {
        rows: attachments
          .filter(item => item.session_id === sessionId)
          .map(item => ({
            id: item.id,
            filename: item.filename,
            content_type: item.content_type,
            byte_count: item.byte_count,
            created_at: item.created_at,
            ...(normalized.includes('content') ? { content: item.content } : {}),
          })),
      };
    }

    if (normalized.startsWith('SELECT * FROM compose_sessions')) {
      const [locator, userId] = params;
      const byId = normalized.includes('WHERE id=$1');
      const row = [...sessions.values()].find(candidate => (
        candidate.user_id === userId
        && (byId ? candidate.id === locator : candidate.slot === locator)
      ));
      return { rows: row ? [{ ...row }] : [] };
    }

    if (normalized.startsWith('UPDATE compose_sessions')) {
      const whereMatch = normalized.match(/WHERE (id|slot)=\$(\d+) AND user_id=\$(\d+)/);
      const locator = params[Number(whereMatch[2]) - 1];
      const userId = params[Number(whereMatch[3]) - 1];
      const row = [...sessions.values()].find(candidate => (
        candidate.user_id === userId
        && (whereMatch[1] === 'id' ? candidate.id === locator : candidate.slot === locator)
      ));
      if (!row) return { rows: [] };
      const tokenMatch = normalized.match(/AND operation_token=\$(\d+)/);
      if (tokenMatch && row.operation_token !== params[Number(tokenMatch[1]) - 1]) {
        return { rows: [] };
      }

      const setClause = normalized.match(/SET (.+) WHERE/)[1];
      for (const assignment of setClause.split(', ')) {
        const valueMatch = assignment.match(/^([a-z_]+)=\$(\d+)/);
        if (valueMatch) {
          const [, column, index] = valueMatch;
          const value = params[Number(index) - 1];
          row[column] = assignment.includes('::jsonb') ? parseJson(value) : value;
        } else if (assignment === 'revision=revision + 1') {
          row.revision += 1;
        } else if (assignment === 'last_focused_at=NOW()') {
          row.last_focused_at = new Date('2026-08-01T00:05:00.000Z');
        } else if (assignment === 'updated_at=NOW()') {
          row.updated_at = new Date('2026-08-01T00:05:00.000Z');
        } else if (assignment === "operation_state='idle'") {
          row.operation_state = 'idle';
        } else if (assignment === 'operation_token=NULL') {
          row.operation_token = null;
        }
      }
      return { rows: [{ ...row }] };
    }

    throw new Error(`Unexpected SQL in fake: ${normalized}`);
  });

  return {
    deps: {
      query,
      withTransaction: vi.fn(async callback => callback({ query })),
      broadcast: vi.fn(),
    },
    deleteSession(id) { sessions.delete(id); },
    setOperationState(id, operationState) { sessions.get(id).operation_state = operationState; },
    getSession(id) { return sessions.get(id); },
    addAttachment(id, metadata) {
      attachments.push({ session_id: id, content: Buffer.from('not returned'), ...metadata });
    },
    getAttachment(id) { return attachments.find(item => item.id === id); },
  };
}

function expectExactInvalidationKeys(broadcast) {
  for (const [payload, userId] of broadcast.mock.calls) {
    expect(userId).toBe(USER_A);
    const keys = [
      'action', 'revision', 'sessionId', 'slot', 'type',
    ];
    if (Object.hasOwn(payload, 'clientId')) keys.push('clientId');
    expect(Object.keys(payload).sort()).toEqual(keys.sort());
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(256);
    expect(payload).not.toHaveProperty('subject');
    expect(payload).not.toHaveProperty('body');
    expect(payload).not.toHaveProperty('to');
    if (payload.clientId !== undefined) {
      expect(payload.clientId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  }
}

describe('compose session persistence', () => {
  it('locks the user allocation key before selecting a free slot', async () => {
    const { deps } = fakeDependencies();
    await createComposeSession({ userId: USER_A, changes: {} }, deps);

    const lockIndex = deps.query.mock.calls.findIndex(([sql]) => (
      sql === 'SELECT pg_advisory_xact_lock(hashtext($1))'
    ));
    const allocationIndex = deps.query.mock.calls.findIndex(([sql]) => (
      sql.includes('generate_series(1, 9)')
    ));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(deps.query.mock.calls[lockIndex]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`compose-slots:${USER_A}`],
    ]);
    expect(allocationIndex).toBeGreaterThan(lockIndex);
  });

  it('allocates, patches, merges disjoint stale fields, and reports same-field conflicts', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: { accountId: ACCOUNT_A, aliasId: ALIAS_A, subject: 'hello' },
      clientId: 'browser-a',
    }, deps);
    expect(created).toMatchObject({ slot: 1, revision: 1, subject: 'hello' });

    await expect(createComposeSession({
      userId: USER_A,
      requestedSlot: 1,
      changes: {},
    }, deps)).rejects.toMatchObject({ code: 'compose_slot_occupied', status: 409 });

    const patched = await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'new subject' },
      clientId: 'mcp-token-1',
    }, deps);
    expect(patched).toMatchObject({ revision: 2, subject: 'new subject' });

    const merged = await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { body: 'A disjoint edit' },
    }, deps);
    expect(merged).toMatchObject({ revision: 3, subject: 'new subject', body: 'A disjoint edit' });

    await expect(patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'stale subject' },
    }, deps)).rejects.toMatchObject({
      code: 'compose_conflict',
      status: 409,
      details: {
        conflictingFields: ['subject'],
        currentRevision: 3,
        remoteValues: { subject: 'new subject' },
      },
    });

    expectExactInvalidationKeys(deps.broadcast);
    expect(deps.broadcast.mock.calls).toEqual([
      [{
        type: 'compose_sessions_updated',
        action: 'created',
        sessionId: created.id,
        slot: 1,
        revision: 1,
        clientId: 'browser-a',
      }, USER_A],
      [{
        type: 'compose_sessions_updated',
        action: 'updated',
        sessionId: created.id,
        slot: 1,
        revision: 2,
        clientId: 'mcp-token-1',
      }, USER_A],
      [{
        type: 'compose_sessions_updated',
        action: 'updated',
        sessionId: created.id,
        slot: 1,
        revision: 3,
      }, USER_A],
    ]);
  });

  it('reuses the lowest free slot and rejects a tenth session', async () => {
    const fake = fakeDependencies();
    const created = [];
    for (let requestedSlot = 1; requestedSlot <= 3; requestedSlot += 1) {
      created.push(await createComposeSession({
        userId: USER_A,
        requestedSlot,
        changes: {},
      }, fake.deps));
    }
    fake.deleteSession(created[1].id);
    await expect(createComposeSession({ userId: USER_A, changes: {} }, fake.deps))
      .resolves.toMatchObject({ slot: 2 });
    for (let requestedSlot = 4; requestedSlot <= 9; requestedSlot += 1) {
      await createComposeSession({ userId: USER_A, requestedSlot, changes: {} }, fake.deps);
    }
    await expect(createComposeSession({ userId: USER_A, changes: {} }, fake.deps))
      .rejects.toMatchObject({ code: 'compose_session_limit', status: 409 });
  });

  it('scopes UUID operations and account identities to the owner', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: { accountId: ACCOUNT_A },
    }, deps);

    await expect(getComposeSession({ userId: USER_B, id: created.id }, deps))
      .rejects.toMatchObject({ code: 'compose_session_not_found', status: 404 });
    await expect(patchComposeSession({
      userId: USER_B,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'cross-owner edit' },
    }, deps)).rejects.toMatchObject({ code: 'compose_session_not_found', status: 404 });
    await expect(createComposeSession({
      userId: USER_B,
      changes: { accountId: ACCOUNT_A },
    }, deps)).rejects.toMatchObject({ code: 'compose_account_not_found', status: 404 });
  });

  it('round-trips non-editable reply-all source recipients across reloads', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: { mode: 'reply', to: ['Sender <sender@example.com>'] },
      replyAllRecipients: ['Copied <copied@example.com>'],
    }, deps);
    expect(created.replyAllRecipients).toEqual(['Copied <copied@example.com>']);

    const patched = await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'Synthetic reply', replyAllRecipients: ['ignored@example.com'] },
    }, deps);
    expect(patched.replyAllRecipients).toEqual(['Copied <copied@example.com>']);
    await expect(getComposeSession({ userId: USER_A, id: created.id }, deps))
      .resolves.toMatchObject({ replyAllRecipients: ['Copied <copied@example.com>'] });
  });

  it('rejects aliases from another account or owner', async () => {
    const { deps } = fakeDependencies();

    await expect(createComposeSession({
      userId: USER_A,
      changes: { accountId: ACCOUNT_A2, aliasId: ALIAS_A },
    }, deps)).rejects.toMatchObject({ code: 'compose_alias_not_found', status: 404 });
    await expect(createComposeSession({
      userId: USER_B,
      changes: { accountId: ACCOUNT_B, aliasId: ALIAS_A },
    }, deps)).rejects.toMatchObject({ code: 'compose_alias_not_found', status: 404 });
  });

  it('rejects edits while a terminal operation owns the row', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);
    await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'newer server value' },
    }, fake.deps);
    fake.setOperationState(created.id, 'sending');

    await expect(patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'too late' },
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_operation_in_progress',
      status: 409,
    });
  });

  it.each([
    ['not-an-object'],
    [null],
    [[{ subject: 'array is not changes' }]],
  ])('rejects non-object changes before opening a transaction %#', async (changes) => {
    const { deps } = fakeDependencies();

    await expect(createComposeSession({ userId: USER_A, changes }, deps))
      .rejects.toMatchObject({ code: 'invalid_compose_changes', status: 400 });
    expect(deps.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects malformed patch field types without changing the session', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, deps);

    await expect(patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { to: 'recipient@example.com', bodyIsHtml: 'yes' },
    }, deps)).rejects.toMatchObject({ code: 'invalid_compose_changes', status: 400 });
    await expect(getComposeSession({ userId: USER_A, id: created.id }, deps))
      .resolves.toMatchObject({ revision: 1, to: [], bodyIsHtml: true });
  });

  it.each([
    ['person@example.com'],
    ['contains spaces'],
    ['x'.repeat(65)],
    [{ private: 'content' }],
  ])('rejects malformed client ids before persistence %#', async (clientId) => {
    const { deps } = fakeDependencies();

    await expect(createComposeSession({
      userId: USER_A,
      changes: {},
      clientId,
    }, deps)).rejects.toMatchObject({ code: 'invalid_client_id', status: 400 });
    expect(deps.withTransaction).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('builds patch SQL only from the fixed editable-field map', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, deps);
    const injectedField = 'subject=$1; DROP TABLE compose_sessions; --';

    await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'Allowed value', [injectedField]: 'not SQL' },
    }, deps);

    const updateSql = deps.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE compose_sessions'))[0];
    expect(updateSql).toContain('subject=$1');
    expect(updateSql).not.toContain('DROP TABLE');
    expect(updateSql).not.toContain(injectedField);
  });

  it('returns content-minimal summaries and metadata-only snapshots by id or slot', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: {
        to: ['Recipient <recipient@example.com>'],
        subject: 'Summary title',
        body: 'Private body',
        quotedBody: 'Private quote',
      },
    }, fake.deps);
    fake.addAttachment(created.id, {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      filename: 'synthetic.txt',
      content_type: 'text/plain',
      byte_count: 12,
      created_at: ATTACHMENT_AT,
    });

    const [summary] = await listComposeSessions({ userId: USER_A }, fake.deps);
    expect(summary).toStrictEqual({
      id: created.id,
      slot: 1,
      accountId: null,
      aliasId: null,
      mode: 'new',
      subject: 'Summary title',
      priority: 'normal',
      presentationState: 'expanded',
      operationState: 'idle',
      revision: 1,
      lastFocusedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      attachmentCount: 1,
    });

    const byId = await getComposeSession({ userId: USER_A, id: created.id }, fake.deps);
    const bySlot = await getComposeSession({ userId: USER_A, slot: 1 }, fake.deps);
    expect(byId).toStrictEqual(bySlot);
    expect(byId).toStrictEqual({
      id: created.id,
      slot: 1,
      accountId: null,
      aliasId: null,
      mode: 'new',
      to: ['Recipient <recipient@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Summary title',
      body: 'Private body',
      bodyIsHtml: true,
      quotedBody: 'Private quote',
      quotedBodyHtml: null,
      editedSignature: null,
      forwardedAttachments: [],
      priority: 'normal',
      inReplyTo: null,
      references: [],
      fromChanged: false,
      replyAllRecipients: [],
      sourceDraftAccountId: undefined,
      sourceDraftFolder: undefined,
      sourceDraftUid: undefined,
      sourceDraftMessageId: undefined,
      sourceInitialRevision: null,
      presentationState: 'expanded',
      operationState: 'idle',
      operationToken: null,
      revision: 1,
      fieldRevisions: { to: 1, subject: 1, body: 1, quotedBody: 1 },
      lastFocusedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      attachments: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        filename: 'synthetic.txt',
        contentType: 'text/plain',
        byteCount: 12,
        createdAt: ATTACHMENT_AT,
      }],
    });

    const listSql = fake.deps.query.mock.calls
      .find(([sql]) => sql.includes('attachment_count'))[0];
    expect(listSql.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT cs.id, cs.slot, cs.account_id, cs.alias_id, cs.mode, cs.subject, '
      + 'cs.priority, cs.presentation_state, cs.operation_state, cs.revision, '
      + 'cs.last_focused_at, cs.created_at, cs.updated_at, '
      + 'COUNT(csa.id)::int AS attachment_count FROM compose_sessions cs '
      + 'LEFT JOIN compose_session_attachments csa ON csa.session_id=cs.id '
      + 'WHERE cs.user_id=$1 GROUP BY cs.id ORDER BY cs.slot',
    );
    const attachmentSql = fake.deps.query.mock.calls
      .find(([sql]) => sql.includes('FROM compose_session_attachments'))[0];
    expect(attachmentSql.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id, filename, content_type, byte_count, created_at '
      + 'FROM compose_session_attachments WHERE session_id=$1 ORDER BY created_at, id',
    );
  });

  it('requires exactly one owner-scoped locator', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, deps);

    await expect(getComposeSession({ userId: USER_A }, deps))
      .rejects.toMatchObject({ code: 'invalid_compose_locator', status: 400 });
    await expect(getComposeSession({ userId: USER_A, id: created.id, slot: 1 }, deps))
      .rejects.toMatchObject({ code: 'invalid_compose_locator', status: 400 });
    await expect(patchComposeSession({
      userId: USER_A,
      expectedRevision: 1,
      changes: { subject: 'missing locator' },
    }, deps)).rejects.toMatchObject({ code: 'invalid_compose_locator', status: 400 });
    await expect(getComposeSession({ userId: USER_A, id: 'not-a-uuid' }, deps))
      .rejects.toMatchObject({ code: 'invalid_compose_locator', status: 400 });
    await expect(removeComposeAttachment({
      userId: USER_A,
      id: created.id,
      attachmentId: 'not-a-uuid',
      expectedRevision: 1,
    }, deps)).rejects.toMatchObject({ code: 'invalid_compose_attachment_id', status: 400 });
  });

  it('revision-checks presentation changes and focuses only expanded sessions', async () => {
    const { deps } = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, deps);

    const minimized = await setComposePresentation({
      userId: USER_A,
      slot: 1,
      expectedRevision: 1,
      state: 'minimized',
    }, deps);
    expect(minimized).toMatchObject({ presentationState: 'minimized', revision: 2 });
    const minimizeSql = deps.query.mock.calls.filter(([sql]) => (
      sql.startsWith('UPDATE compose_sessions')
    )).at(-1)[0];
    expect(minimizeSql).not.toContain('last_focused_at=NOW()');

    const expanded = await setComposePresentation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 2,
      state: 'expanded',
    }, deps);
    expect(expanded).toMatchObject({ presentationState: 'expanded', revision: 3 });
    const expandSql = deps.query.mock.calls.filter(([sql]) => (
      sql.startsWith('UPDATE compose_sessions')
    )).at(-1)[0];
    expect(expandSql).toContain('last_focused_at=NOW()');
    expectExactInvalidationKeys(deps.broadcast);
    expect(deps.broadcast.mock.calls.slice(1)).toEqual([
      [{
        type: 'compose_sessions_updated',
        action: 'presentation',
        sessionId: created.id,
        slot: 1,
        revision: 2,
      }, USER_A],
      [{
        type: 'compose_sessions_updated',
        action: 'presentation',
        sessionId: created.id,
        slot: 1,
        revision: 3,
      }, USER_A],
    ]);

    await expect(setComposePresentation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      state: 'minimized',
    }, deps)).rejects.toMatchObject({
      code: 'compose_conflict',
      details: { conflictingFields: ['presentationState'], currentRevision: 3 },
    });
    await expect(setComposePresentation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 3,
      state: 'hidden',
    }, deps)).rejects.toMatchObject({ code: 'invalid_presentation_state', status: 400 });
  });

  it('adds attachment bytes with a sanitized filename and metadata-only result', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);
    const content = Buffer.from([0, 1, 2, 254, 255]);

    const added = await addComposeAttachment({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      filename: 'synthetic\r\n\0report.bin',
      contentType: 'application/octet-stream',
      content,
      clientId: 'browser-attachment',
    }, fake.deps);

    expect(added).toStrictEqual({
      sessionId: created.id,
      slot: 1,
      revision: 2,
      attachment: {
        id: '10000000-0000-4000-8000-000000000001',
        filename: 'syntheticreport.bin',
        contentType: 'application/octet-stream',
        byteCount: 5,
        createdAt: ATTACHMENT_AT,
      },
    });
    expect(Object.keys(added.attachment).sort()).toEqual([
      'byteCount', 'contentType', 'createdAt', 'filename', 'id',
    ]);
    const stored = fake.getAttachment(added.attachment.id);
    expect(Buffer.isBuffer(stored.content)).toBe(true);
    expect(stored.content).toEqual(content);
    expect(stored.content).not.toBe(content);
    expect(stored.byte_count).toBe(content.length);

    const snapshot = await getComposeSession({ userId: USER_A, id: created.id }, fake.deps);
    expect(snapshot).toMatchObject({ revision: 2, fieldRevisions: { attachments: 2 } });
    expectExactInvalidationKeys(fake.deps.broadcast);
    expect(fake.deps.broadcast.mock.calls.at(-1)).toEqual([{
      type: 'compose_sessions_updated',
      action: 'attachment_added',
      sessionId: created.id,
      slot: 1,
      revision: 2,
      clientId: 'browser-attachment',
    }, USER_A]);
  });

  it.each([
    [{ content: 'not-a-buffer' }, 'invalid_attachment_body'],
    [{ filename: '' }, 'invalid_attachment_filename'],
    [{ filename: 42 }, 'invalid_attachment_filename'],
    [{ contentType: 'not-a-mime-type' }, 'invalid_attachment_content_type'],
    [{ contentType: 'text/plain\r\nX-Injected: yes' }, 'invalid_attachment_content_type'],
  ])('rejects malformed attachment input %#', async (override, code) => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);

    await expect(addComposeAttachment({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      filename: 'synthetic.bin',
      contentType: 'application/octet-stream',
      content: Buffer.from('synthetic'),
      ...override,
    }, fake.deps)).rejects.toMatchObject({ code, status: 400 });
    expect(fake.deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it('accepts an attachment exactly at the aggregate 25 MiB boundary', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);

    await expect(addComposeAttachment({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      filename: 'exact-boundary.bin',
      contentType: 'application/octet-stream',
      content: Buffer.alloc(MAX_ATTACHMENT_BYTES),
    }, fake.deps)).resolves.toMatchObject({
      revision: 2,
      attachment: { byteCount: MAX_ATTACHMENT_BYTES },
    });
  });

  it('rejects a 101st attachment before storing more bytes', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);
    for (let index = 0; index < 100; index += 1) {
      fake.addAttachment(created.id, {
        id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        filename: `synthetic-${index}.txt`,
        content_type: 'text/plain',
        byte_count: 1,
        created_at: ATTACHMENT_AT,
      });
    }

    await expect(addComposeAttachment({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      filename: 'one-too-many.txt',
      contentType: 'text/plain',
      content: Buffer.from('x'),
    }, fake.deps)).rejects.toMatchObject({ code: 'attachment_count_limit', status: 413 });
    expect(fake.deps.query.mock.calls.some(([sql]) => (
      sql.startsWith('INSERT INTO compose_session_attachments')
    ))).toBe(false);
  });

  it('rejects attachment bytes above the aggregate 25 MiB limit', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);
    fake.addAttachment(created.id, {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      filename: 'existing.bin',
      content_type: 'application/octet-stream',
      byte_count: MAX_ATTACHMENT_BYTES - 1,
      created_at: ATTACHMENT_AT,
    });

    await expect(addComposeAttachment({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      filename: 'too-big.bin',
      contentType: 'application/octet-stream',
      content: Buffer.alloc(2),
    }, fake.deps)).rejects.toMatchObject({ code: 'attachment_limit', status: 413 });

    expect(fake.deps.query.mock.calls.some(([sql]) => (
      sql.includes('COALESCE(SUM(byte_count), 0)')
    ))).toBe(true);
    expect(fake.deps.query.mock.calls.some(([sql]) => (
      sql.startsWith('INSERT INTO compose_session_attachments')
    ))).toBe(false);
    expect(fake.deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it('owner-scopes attachment mutations and applies the operation guard', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);

    await expect(addComposeAttachment({
      userId: USER_B,
      id: created.id,
      expectedRevision: 1,
      filename: 'out-of-scope.txt',
      contentType: 'text/plain',
      content: Buffer.from('synthetic'),
    }, fake.deps)).rejects.toMatchObject({ code: 'compose_session_not_found', status: 404 });

    fake.setOperationState(created.id, 'sending');
    await expect(removeComposeAttachment({
      userId: USER_A,
      id: created.id,
      attachmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expectedRevision: 1,
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_operation_in_progress',
      status: 409,
    });
  });

  it('removes attachments idempotently and increments revision only when present', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);
    const added = await addComposeAttachment({
      userId: USER_A,
      slot: 1,
      expectedRevision: 1,
      filename: 'remove-me.txt',
      contentType: 'text/plain',
      content: Buffer.from('reserved test content'),
    }, fake.deps);

    const removed = await removeComposeAttachment({
      userId: USER_A,
      id: created.id,
      attachmentId: added.attachment.id,
      expectedRevision: 2,
      clientId: 'browser-remove',
    }, fake.deps);
    expect(removed).toStrictEqual({
      sessionId: created.id,
      slot: 1,
      revision: 3,
      removedAttachmentId: added.attachment.id,
    });
    expect(fake.getAttachment(added.attachment.id)).toBeUndefined();
    expect(fake.deps.broadcast.mock.calls.at(-1)).toEqual([{
      type: 'compose_sessions_updated',
      action: 'attachment_removed',
      sessionId: created.id,
      slot: 1,
      revision: 3,
      clientId: 'browser-remove',
    }, USER_A]);

    const broadcastsAfterRemoval = fake.deps.broadcast.mock.calls.length;
    const absent = await removeComposeAttachment({
      userId: USER_A,
      id: created.id,
      attachmentId: added.attachment.id,
      expectedRevision: 2,
    }, fake.deps);
    expect(absent).toStrictEqual({
      sessionId: created.id,
      slot: 1,
      revision: 3,
      removedAttachmentId: added.attachment.id,
    });
    expect(fake.deps.broadcast).toHaveBeenCalledTimes(broadcastsAfterRemoval);

    const deleteSql = fake.deps.query.mock.calls.find(([sql]) => (
      sql.startsWith('DELETE FROM compose_session_attachments csa')
    ))[0].replace(/\s+/g, ' ').trim();
    expect(deleteSql).toContain('USING compose_sessions cs');
    expect(deleteSql).toContain('csa.session_id=cs.id');
    expect(deleteSql).toContain('cs.user_id=$3');
  });

  it('does not remove an attachment through another owner or compose session', async () => {
    const fake = fakeDependencies();
    const first = await createComposeSession({
      userId: USER_A,
      requestedSlot: 1,
      changes: {},
    }, fake.deps);
    const second = await createComposeSession({
      userId: USER_A,
      requestedSlot: 2,
      changes: {},
    }, fake.deps);
    const added = await addComposeAttachment({
      userId: USER_A,
      id: first.id,
      expectedRevision: 1,
      filename: 'owned-by-first.txt',
      contentType: 'text/plain',
      content: Buffer.from('synthetic'),
    }, fake.deps);

    await expect(removeComposeAttachment({
      userId: USER_B,
      id: first.id,
      attachmentId: added.attachment.id,
      expectedRevision: 2,
    }, fake.deps)).rejects.toMatchObject({ code: 'compose_session_not_found', status: 404 });
    await expect(removeComposeAttachment({
      userId: USER_A,
      id: second.id,
      attachmentId: added.attachment.id,
      expectedRevision: 1,
    }, fake.deps)).resolves.toMatchObject({
      sessionId: second.id,
      slot: 2,
      revision: 1,
      removedAttachmentId: added.attachment.id,
    });
    expect(fake.getAttachment(added.attachment.id)).toBeDefined();
  });

  it('atomically claims an operation with final changes and complete attachment bytes', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: { accountId: ACCOUNT_A, subject: 'Initial subject' },
    }, fake.deps);
    const added = await addComposeAttachment({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      filename: 'claim.txt',
      contentType: 'text/plain',
      content: Buffer.from('synthetic claim bytes'),
    }, fake.deps);

    const claimed = await claimComposeOperation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 2,
      operation: 'closing',
      changes: { subject: 'Final subject' },
    }, fake.deps);

    expect(claimed).toMatchObject({
      id: created.id,
      slot: 1,
      subject: 'Final subject',
      revision: 3,
      fieldRevisions: { accountId: 1, subject: 3, attachments: 2 },
      operationState: 'closing',
    });
    expect(claimed.operationToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claimed.attachments).toStrictEqual([{
      id: added.attachment.id,
      filename: 'claim.txt',
      contentType: 'text/plain',
      byteCount: 21,
      content: Buffer.from('synthetic claim bytes'),
      createdAt: ATTACHMENT_AT,
    }]);

    await expect(claimComposeOperation({
      userId: USER_A,
      slot: 1,
      expectedRevision: 3,
      operation: 'sending',
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_operation_in_progress',
      status: 409,
    });

    await expect(patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 3,
      changes: { body: 'blocked while claimed' },
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_operation_in_progress',
      status: 409,
    });
  });

  it('rejects a stale conflicting operation final patch without claiming the row', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: { subject: 'Base subject' },
    }, fake.deps);
    await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'Remote subject' },
    }, fake.deps);

    await expect(claimComposeOperation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      operation: 'closing',
      changes: { subject: 'Stale final subject' },
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_conflict',
      status: 409,
      details: {
        conflictingFields: ['subject'],
        currentRevision: 2,
        remoteValues: { subject: 'Remote subject' },
      },
    });
    expect(fake.getSession(created.id)).toMatchObject({
      operation_state: 'idle',
      operation_token: null,
      revision: 2,
      subject: 'Remote subject',
    });
  });

  it('rejects a stale no-change operation claim without claiming the row', async () => {
    const fake = fakeDependencies();
    const stale = await createComposeSession({
      userId: USER_A,
      requestedSlot: 1,
      changes: { subject: 'Base subject' },
    }, fake.deps);
    await patchComposeSession({
      userId: USER_A,
      id: stale.id,
      expectedRevision: 1,
      changes: { subject: 'New server subject' },
    }, fake.deps);

    await expect(claimComposeOperation({
      userId: USER_A,
      id: stale.id,
      expectedRevision: 1,
      operation: 'sending',
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_conflict',
      status: 409,
      details: {
        conflictingFields: ['revision'],
        currentRevision: 2,
        remoteValues: { revision: 2 },
      },
    });
    expect(fake.getSession(stale.id)).toMatchObject({
      operation_state: 'idle',
      operation_token: null,
      revision: 2,
    });
  });

  it('rejects a future no-change operation claim without claiming the row', async () => {
    const fake = fakeDependencies();
    const future = await createComposeSession({
      userId: USER_A,
      changes: {},
    }, fake.deps);
    await expect(claimComposeOperation({
      userId: USER_A,
      slot: 1,
      expectedRevision: 2,
      operation: 'discarding',
    }, fake.deps)).rejects.toMatchObject({
      code: 'compose_conflict',
      status: 409,
      details: {
        conflictingFields: ['revision'],
        currentRevision: 1,
        remoteValues: { revision: 1 },
      },
    });
    expect(fake.getSession(future.id)).toMatchObject({
      operation_state: 'idle',
      operation_token: null,
      revision: 1,
    });
  });

  it('accepts a stale disjoint operation final patch and advances its field revision', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({
      userId: USER_A,
      changes: { subject: 'Base subject' },
    }, fake.deps);
    await patchComposeSession({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      changes: { subject: 'New server subject' },
    }, fake.deps);

    const claimed = await claimComposeOperation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      operation: 'closing',
      changes: { body: 'Disjoint final body' },
    }, fake.deps);
    expect(claimed).toMatchObject({
      revision: 3,
      subject: 'New server subject',
      body: 'Disjoint final body',
      operationState: 'closing',
      fieldRevisions: { subject: 2, body: 3 },
    });
  });

  it('validates operation claims before opening a transaction', async () => {
    const { deps } = fakeDependencies();

    await expect(claimComposeOperation({
      userId: USER_A,
      id: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 1,
      operation: 'idle',
    }, deps)).rejects.toMatchObject({ code: 'invalid_compose_operation', status: 400 });
    await expect(claimComposeOperation({
      userId: USER_A,
      id: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      operation: 'closing',
    }, deps)).rejects.toMatchObject({ code: 'invalid_compose_revision', status: 400 });
    expect(deps.withTransaction).not.toHaveBeenCalled();
  });

  it('releases and deletes operations only for the owner locator and matching token', async () => {
    const fake = fakeDependencies();
    const created = await createComposeSession({ userId: USER_A, changes: {} }, fake.deps);
    const firstClaim = await claimComposeOperation({
      userId: USER_A,
      id: created.id,
      expectedRevision: 1,
      operation: 'closing',
    }, fake.deps);
    const wrongToken = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    await expect(releaseComposeOperation({
      userId: USER_A,
      id: created.id,
      token: wrongToken,
    }, fake.deps)).resolves.toBe(false);
    expect(fake.getSession(created.id)).toMatchObject({
      operation_state: 'closing',
      operation_token: firstClaim.operationToken,
    });
    await expect(releaseComposeOperation({
      userId: USER_B,
      id: created.id,
      token: firstClaim.operationToken,
    }, fake.deps)).resolves.toBe(false);
    await expect(releaseComposeOperation({
      userId: USER_A,
      id: created.id,
      token: firstClaim.operationToken,
    }, fake.deps)).resolves.toBe(true);
    expect(fake.getSession(created.id)).toMatchObject({
      operation_state: 'idle',
      operation_token: null,
    });

    const secondClaim = await claimComposeOperation({
      userId: USER_A,
      slot: 1,
      expectedRevision: 1,
      operation: 'discarding',
    }, fake.deps);
    await expect(deleteClaimedComposeSession({
      userId: USER_A,
      slot: 1,
      token: wrongToken,
    }, fake.deps)).resolves.toBe(false);
    expect(fake.getSession(created.id)).toBeDefined();
    await expect(deleteClaimedComposeSession({
      userId: USER_B,
      slot: 1,
      token: secondClaim.operationToken,
    }, fake.deps)).resolves.toBe(false);
    await expect(deleteClaimedComposeSession({
      userId: USER_A,
      slot: 1,
      token: secondClaim.operationToken,
    }, fake.deps)).resolves.toBe(true);
    expect(fake.getSession(created.id)).toBeUndefined();

    const releaseSql = fake.deps.query.mock.calls.find(([sql]) => (
      sql.startsWith('UPDATE compose_sessions') && sql.includes("operation_state='idle'")
    ))[0].replace(/\s+/g, ' ').trim();
    expect(releaseSql).toContain('WHERE id=$1 AND user_id=$2 AND operation_token=$3');
    const deleteSql = fake.deps.query.mock.calls.find(([sql]) => (
      sql.startsWith('DELETE FROM compose_sessions')
    ))[0].replace(/\s+/g, ' ').trim();
    expect(deleteSql).toContain('WHERE slot=$1 AND user_id=$2 AND operation_token=$3');
  });
});
