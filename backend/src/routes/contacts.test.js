import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn((req, res, next) => next()) }));
vi.mock('../services/carddavContactService.js', () => ({
  CARDDAV_CONTACT_ERROR_STATUS: {
    ERR_CONTACT_VALIDATION: 400,
    ERR_CONTACT_UID_MISMATCH: 400,
    ERR_CONTACT_NOT_FOUND: 404,
    ERR_ADDRESS_BOOK_NOT_FOUND: 404,
    ERR_CONTACT_EXISTS: 409,
    ERR_CARDDAV_CONFLICT: 409,
    ERR_CARDDAV_FINAL_FENCE: 503,
    ERR_CARDDAV_STALE_GENERATION: 503,
    ERR_CARDDAV_AMBIGUOUS_WRITE: 409,
    ERR_CARDDAV_PENDING_INTENT: 409,
    ERR_CARDDAV_READ_ONLY: 403,
    '23505': 409,
  },
  createContact: mocks.createContact,
  updateContact: mocks.updateContact,
  deleteContact: mocks.deleteContact,
}));

const { default: router } = await import('./contacts.js');

function handler(method, path) {
  return router.stack
    .find(layer => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;
}

const listHandler = handler('get', '/');
const getHandler = handler('get', '/:id');
const createHandler = handler('post', '/');
const updateHandler = handler('patch', '/:id');
const deleteHandler = handler('delete', '/:id');

function response() {
  return {
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  };
}

function draft(overrides = {}) {
  return {
    displayName: 'Ada Lovelace',
    firstName: 'Ada',
    lastName: 'Lovelace',
    emails: [{ value: 'ada@example.test', type: 'work' }],
    phones: [],
    organization: 'Analytical Engines',
    notes: 'First programmer',
    photoData: 'data:image/png;base64,AQID',
    additionalFields: [{ id: 'site', kind: 'url', label: 'Website', value: 'https://example.test' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contact read routes', () => {
  it('lists contacts with CardDAV sync, capability, Additional-field, photo, and conflict state', async () => {
    const contact = {
      id: 'contact-1',
      sync_state: 'conflict',
      remote_create_capability: 'allowed',
      remote_update_capability: 'unknown',
      remote_delete_capability: 'denied',
      additional_fields: [{ id: 'site', kind: 'url', value: 'https://example.test' }],
      has_photo: true,
      conflict_id: 'conflict-1',
      read_only: false,
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [contact] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    const res = response();

    await listHandler({ session: { userId: 'user-1' }, query: {} }, res);

    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain('carddav_remote_objects');
    expect(sql).toContain('carddav_conflicts');
    expect(sql).toContain('remote_update_capability');
    expect(sql).not.toContain("(ab.source = 'carddav') AS read_only");
    expect(res.json).toHaveBeenCalledWith({ contacts: [contact], total: 1 });
  });

  it('gets the same CardDAV state projection without mutating it', async () => {
    const contact = {
      id: 'contact-1',
      sync_state: 'synced',
      remote_update_capability: 'allowed',
      remote_delete_capability: 'allowed',
      additional_fields: [],
      photo_data: null,
      has_photo: false,
      conflict_id: null,
      read_only: false,
    };
    mocks.query.mockResolvedValueOnce({ rows: [contact] });
    const res = response();

    await getHandler({ session: { userId: 'user-1' }, params: { id: 'contact-1' } }, res);

    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain('carddav_remote_objects');
    expect(sql).toContain('carddav_conflicts');
    expect(sql).not.toMatch(/\bc\.vcard\b/);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(res.json).toHaveBeenCalledWith(contact);
    expect(res.json.mock.calls[0][0]).toBe(contact);
  });
});

describe('POST /api/contacts', () => {
  it('delegates exactly once and preserves local-only response behavior', async () => {
    const body = draft();
    const created = { id: 'contact-1', ...body };
    mocks.createContact.mockResolvedValueOnce(created);
    const res = response();

    await createHandler({ session: { userId: 'user-1' }, body }, res);

    expect(mocks.createContact).toHaveBeenCalledTimes(1);
    expect(mocks.createContact).toHaveBeenCalledWith('user-1', body);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(created);
  });

  it.each([
    ['emails', draft({ emails: 'not-an-array' }), 'emails must be an array'],
    ['phones', draft({ phones: 'not-an-array' }), 'phones must be an array'],
    ['Additional fields', draft({ additionalFields: {} }), 'additionalFields must be an array'],
    ['photo MIME', draft({ photoData: 'data:image/gif;base64,AQID' }), 'photoData must be a JPEG or PNG data URI'],
    ['photo encoding', draft({ photoData: 'data:image/png;base64,***' }), 'photoData must contain valid base64 data'],
    ['photo size', draft({ photoData: `data:image/jpeg;base64,${Buffer.alloc(512 * 1024 + 1).toString('base64')}` }), 'photoData must not exceed 512 KiB'],
  ])('rejects invalid %s before delegation', async (_case, body, error) => {
    const res = response();

    await createHandler({ session: { userId: 'user-1' }, body }, res);

    expect(mocks.createContact).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error });
  });
});

describe('PATCH /api/contacts/:id', () => {
  it('delegates a writable mapped contact exactly once', async () => {
    const body = draft({ displayName: 'Ada Byron' });
    const updated = { id: 'contact-1', ...body };
    mocks.updateContact.mockResolvedValueOnce(updated);
    const res = response();

    await updateHandler({ session: { userId: 'user-1' }, params: { id: 'contact-1' }, body }, res);

    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    expect(mocks.updateContact).toHaveBeenCalledWith('user-1', 'contact-1', body);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('returns 403 when the operation is denied', async () => {
    mocks.updateContact.mockRejectedValueOnce(Object.assign(
      new Error('This CardDAV address book does not allow update'),
      { code: 'ERR_CARDDAV_READ_ONLY' },
    ));
    const res = response();

    await updateHandler({
      session: { userId: 'user-1' },
      params: { id: 'contact-1' },
      body: { displayName: 'Ada Byron' },
    }, res);

    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'This CardDAV address book does not allow update' });
  });

  it('attempts an unknown-capability operation and reports its upstream denial', async () => {
    mocks.updateContact.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    const res = response();

    await updateHandler({
      session: { userId: 'user-1' },
      params: { id: 'contact-1' },
      body: { displayName: 'Ada Byron' },
    }, res);

    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('returns the durable conflict ID for a stale write', async () => {
    mocks.updateContact.mockRejectedValueOnce(Object.assign(new Error('conflict'), {
      code: 'ERR_CARDDAV_CONFLICT',
      conflictId: 'conflict-1',
    }));
    const res = response();

    await updateHandler({
      session: { userId: 'user-1' },
      params: { id: 'contact-1' },
      body: { displayName: 'Ada Byron' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ conflictId: 'conflict-1' });
  });

  it.each([
    ['ERR_CARDDAV_FINAL_FENCE', 'CardDAV mapping changed after the remote write'],
    ['ERR_CARDDAV_STALE_GENERATION', 'The CardDAV connection changed before export'],
  ])('maps the self-healing %s race to a retriable 503', async (code, message) => {
    mocks.updateContact.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
    const res = response();

    await updateHandler({
      session: { userId: 'user-1' },
      params: { id: 'contact-1' },
      body: { displayName: 'Ada Byron' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: message, code, retriable: true });
  });

  it.each([
    ['ERR_CARDDAV_AMBIGUOUS_WRITE', 'The CardDAV write succeeded, but MailFlow could not confirm its local state'],
    ['ERR_CARDDAV_PENDING_INTENT', 'A CardDAV mutation is already awaiting confirmation'],
  ])('maps the post-write %s to a non-retriable 409 that tells the client to refresh', async (code, message) => {
    mocks.updateContact.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
    const res = response();

    await updateHandler({
      session: { userId: 'user-1' },
      params: { id: 'contact-1' },
      body: { displayName: 'Ada Byron' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: message, code, refresh: true });
    // The remote effect may have landed; never invite a blind re-issue of the mutation.
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('retriable', true);
  });

  it('accepts an explicit photo removal', async () => {
    mocks.updateContact.mockResolvedValueOnce({ id: 'contact-1', photo_data: null });
    const res = response();

    await updateHandler({
      session: { userId: 'user-1' },
      params: { id: 'contact-1' },
      body: { photoData: null, additionalFields: [] },
    }, res);

    expect(mocks.updateContact).toHaveBeenCalledWith('user-1', 'contact-1', {
      photoData: null,
      additionalFields: [],
    });
    expect(res.json).toHaveBeenCalledWith({ id: 'contact-1', photo_data: null });
  });
});

describe('DELETE /api/contacts/:id', () => {
  it('delegates exactly once and preserves the local-only response', async () => {
    mocks.deleteContact.mockResolvedValueOnce({ ok: true });
    const res = response();

    await deleteHandler({ session: { userId: 'user-1' }, params: { id: 'contact-1' } }, res);

    expect(mocks.deleteContact).toHaveBeenCalledTimes(1);
    expect(mocks.deleteContact).toHaveBeenCalledWith('user-1', 'contact-1');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('returns 403 when deletion is denied', async () => {
    mocks.deleteContact.mockRejectedValueOnce(Object.assign(
      new Error('This CardDAV address book does not allow delete'),
      { code: 'ERR_CARDDAV_READ_ONLY' },
    ));
    const res = response();

    await deleteHandler({ session: { userId: 'user-1' }, params: { id: 'contact-1' } }, res);

    expect(mocks.deleteContact).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each([
    ['ERR_CARDDAV_AMBIGUOUS_WRITE', 'The CardDAV write succeeded, but MailFlow could not confirm its local state'],
    ['ERR_CARDDAV_PENDING_INTENT', 'A CardDAV mutation is already awaiting confirmation'],
  ])('maps a post-write %s delete to a non-retriable 409 that tells the client to refresh', async (code, message) => {
    mocks.deleteContact.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
    const res = response();

    await deleteHandler({ session: { userId: 'user-1' }, params: { id: 'contact-1' } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: message, code, refresh: true });
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('retriable', true);
  });
});
