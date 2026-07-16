import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createContactFromVCard: vi.fn(),
  replaceContactFromVCard: vi.fn(),
  deleteContactFromVCard: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    hashSync: vi.fn(() => 'hash'),
    compare: vi.fn(),
  },
}));
vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 5, windowMs: 60_000 },
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
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
  createContactFromVCard: mocks.createContactFromVCard,
  replaceContactFromVCard: mocks.replaceContactFromVCard,
  deleteContactFromVCard: mocks.deleteContactFromVCard,
}));

const { presentedEtag } = await import('../utils/vcardProperties.js');
const { default: router, readRawBody } = await import('./carddav.js');

// A served contact row as readServedContact returns it (modeled columns + retained
// mapping vCard). The served ETag is derived from the presented document.
const SERVED_VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-uid\r\nFN:Confirmed\r\nEND:VCARD\r\n';
function servedContactRow(overrides = {}) {
  return {
    id: 'contact-1', uid: 'contact-uid', etag: 'local-etag', vcard: SERVED_VCARD,
    mapping_vcard: null, display_name: 'Confirmed', first_name: null, last_name: null,
    emails: [], phones: [], organization: null, notes: null, photo_data: null,
    additional_fields: [], ...overrides,
  };
}
const PRESENTED_ETAG = presentedEtag(servedContactRow());
const SERVED_ETAG = `"${PRESENTED_ETAG}"`;

function handler(method, path) {
  return router.stack
    .find(layer => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;
}

const reportHandler = handler('report', '/:userId/:bookId/');
const getHandler = handler('get', '/:userId/:bookId/:filename');
const putHandler = handler('put', '/:userId/:bookId/:filename');
const deleteHandler = handler('delete', '/:userId/:bookId/:filename');

describe('userId route parameter', () => {
  it('rejects a userId that differs from the authenticated CardDAV user', () => {
    const guard = router.params.userId?.[0];
    const res = response();
    const next = vi.fn();

    guard?.({ cardavUserId: 'user-1' }, res, next, 'user-2');

    expect(guard).toBeTypeOf('function');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it('continues when the route and authenticated user IDs match', () => {
    const guard = router.params.userId?.[0];
    const res = response();
    const next = vi.fn();

    guard?.({ cardavUserId: 'user-1' }, res, next, 'user-1');

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

function response() {
  return {
    end: vi.fn(),
    send: vi.fn(),
    set: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
}

function request(overrides = {}) {
  return {
    cardavUserId: 'user-1',
    params: {
      userId: 'user-1',
      bookId: 'book-1',
      filename: 'contact-uid.vcf',
    },
    headers: {},
    body: [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:contact-uid',
      'FN:Ada Lovelace',
      'EMAIL:ada@example.test',
      'END:VCARD',
    ].join('\r\n'),
    ...overrides,
  };
}

function streamingRequest(chunks, overrides = {}) {
  const req = Readable.from(chunks);
  return Object.assign(req, request({ body: undefined }), overrides);
}

function lifecycleRequest(overrides = {}) {
  return Object.assign(new EventEmitter(), request({ body: undefined }), {
    resume: vi.fn(),
    ...overrides,
  });
}

async function settlementWithin(promise, timeoutMs = 25) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const settlement = promise.then(
    value => ({ kind: 'resolved', value }),
    error => ({ kind: 'rejected', error }),
  );
  const result = await Promise.race([settlement, timeout]);
  clearTimeout(timer);
  return result;
}

function mockResource(existing = servedContactRow(), created = existing ?? servedContactRow()) {
  let contactReads = 0;
  mocks.query.mockImplementation(async sql => {
    if (sql.includes('FROM address_books') && !sql.includes('JOIN')) {
      return { rows: [{ id: 'book-1', sync_token: 'sync-1' }] };
    }
    if (sql.includes('FROM contacts c') && sql.includes('c.uid = $3')) {
      // First read = existence/precondition check; a later read = post-write served ETag.
      contactReads++;
      const row = contactReads === 1 ? existing : created;
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('DELETE FROM contacts')) return { rows: [{ book_id: 'book-1' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readRawBody stream lifecycle', () => {
  it('keeps tail errors protected until an over-limit request finishes draining', async () => {
    const tailError = new Error('tail drain failed');
    let unhandledError;
    const req = lifecycleRequest();
    req.resume.mockImplementation(() => {
      try {
        req.emit('error', tailError);
      } catch (error) {
        unhandledError = error;
      }
      req.emit('close');
    });

    const body = readRawBody(req, { maxBytes: 1 });
    req.emit('data', Buffer.from('xx'));

    await expect(body).rejects.toMatchObject({ code: 'ERR_CARDDAV_BODY_TOO_LARGE' });
    expect(unhandledError).toBeUndefined();
    expect(req.resume).toHaveBeenCalledOnce();
    for (const event of ['data', 'end', 'error', 'close', 'aborted']) {
      expect(req.listenerCount(event), event).toBe(0);
    }
  });

  it.each(['close', 'aborted'])(
    'rejects once and detaches when a partial request emits %s without end/error',
    async event => {
      const req = lifecycleRequest();
      let settlements = 0;
      const body = readRawBody(req, { maxBytes: 10 }).then(
        value => {
          settlements += 1;
          return value;
        },
        error => {
          settlements += 1;
          throw error;
        },
      );

      req.emit('data', Buffer.from('partial'));
      req.emit(event);

      const outcome = await settlementWithin(body);
      expect(outcome).toMatchObject({
        kind: 'rejected',
        error: { code: 'ERR_CARDDAV_REQUEST_ABORTED' },
      });
      req.emit(event === 'close' ? 'aborted' : 'close');
      req.emit('end');
      await Promise.resolve();
      expect(settlements).toBe(1);
      for (const listenerEvent of ['data', 'end', 'error', 'close', 'aborted']) {
        expect(req.listenerCount(listenerEvent), listenerEvent).toBe(0);
      }
    },
  );
});

describe('PUT CardDAV contact resource', () => {
  it('returns 400 when the request aborts before its body ends', async () => {
    const req = lifecycleRequest();
    const res = response();

    const handling = putHandler(req, res);
    req.emit('data', Buffer.from('partial'));
    req.emit('aborted');

    expect(await settlementWithin(handling)).toMatchObject({ kind: 'resolved' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
  });

  it('rejects a multi-chunk body at 1 MiB + 1 before delegation, then drains and detaches', async () => {
    mockResource();
    const consumed = [];
    const req = streamingRequest((function* bodyChunks() {
      for (const chunk of [Buffer.alloc(1024 * 1024), Buffer.from('x'), Buffer.from('tail')]) {
        consumed.push(chunk.length);
        yield chunk;
      }
    })());
    const setEncoding = vi.spyOn(req, 'setEncoding');
    const ended = once(req, 'end');
    const res = response();

    await putHandler(req, res);
    await ended;

    expect(res.status).toHaveBeenCalledWith(413);
    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    expect(setEncoding).not.toHaveBeenCalled();
    expect(consumed).toEqual([1024 * 1024, 1, 4]);
    expect(req.readableEnded).toBe(true);
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('end')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
  });

  it.each([
    ['stream', () => streamingRequest([Buffer.alloc(1024 * 1024 - 1), Buffer.from('x')])],
    ['string', () => request({ body: '🙂'.repeat(256 * 1024) })],
    ['Buffer', () => request({ body: Buffer.alloc(1024 * 1024) })],
  ])('allows an exact 1 MiB %s body to reach normal vCard validation', async (_kind, makeRequest) => {
    mockResource();
    mocks.replaceContactFromVCard.mockRejectedValueOnce(
      Object.assign(new Error('invalid vCard'), { code: 'ERR_CONTACT_VALIDATION' }),
    );
    const res = response();

    await putHandler(makeRequest(), res);

    expect(mocks.replaceContactFromVCard).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([
    ['string', '🙂'.repeat(256 * 1024) + 'x'],
    ['Buffer', Buffer.alloc(1024 * 1024 + 1)],
  ])('rejects a pre-collected %s body at 1 MiB + 1 before delegation', async (_kind, body) => {
    mockResource();
    const res = response();

    await putHandler(request({ body }), res);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
  });

  it('delegates a mapped replacement exactly once with raw vCard and matching local ETag', async () => {
    mockResource();
    mocks.replaceContactFromVCard.mockResolvedValueOnce({ etag: 'confirmed-etag' });
    const req = request({ headers: { 'if-match': SERVED_ETAG } });
    const res = response();

    await putHandler(req, res);

    expect(mocks.replaceContactFromVCard).toHaveBeenCalledTimes(1);
    expect(mocks.replaceContactFromVCard).toHaveBeenCalledWith('user-1', {
      localAddressBookId: 'book-1',
      uid: 'contact-uid',
      rawVCard: req.body,
      expectedLocalEtag: 'local-etag',
    });
    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('ETag', SERVED_ETAG);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('requires a conditional request on a mapped PUT: no If-Match → 428, nothing pushed', async () => {
    mockResource(servedContactRow({
      mapping_vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:Confirmed\r\nCATEGORIES:VIP\r\nEND:VCARD\r\n',
    }));
    const res = response();

    await putHandler(request(), res);

    expect(res.status).toHaveBeenCalledWith(428);
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
  });

  it.each([['star', '*'], ['empty', '']])(
    'rejects a mapped PUT whose If-Match is %s (not a real strong ETag) → 428, nothing pushed',
    async (_kind, ifMatch) => {
      mockResource(servedContactRow({
        mapping_vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:Confirmed\r\nCATEGORIES:VIP\r\nEND:VCARD\r\n',
      }));
      const res = response();

      await putHandler(request({ headers: { 'if-match': ifMatch } }), res);

      expect(res.status).toHaveBeenCalledWith(428);
      expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    });

  it('delegates a mapped PUT that carries a matching If-Match', async () => {
    const mapped = servedContactRow({
      mapping_vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:Confirmed\r\nCATEGORIES:VIP\r\nEND:VCARD\r\n',
    });
    mockResource(mapped);
    mocks.replaceContactFromVCard.mockResolvedValueOnce({ etag: 'x' });
    const res = response();

    await putHandler(request({ headers: { 'if-match': `"${presentedEtag(mapped)}"` } }), res);

    expect(mocks.replaceContactFromVCard).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('delegates a new resource exactly once with its local book, UID, and raw vCard', async () => {
    mockResource(null);
    mocks.createContactFromVCard.mockResolvedValueOnce({ etag: 'confirmed-etag' });
    const req = request();
    const res = response();

    await putHandler(req, res);

    expect(mocks.createContactFromVCard).toHaveBeenCalledTimes(1);
    expect(mocks.createContactFromVCard).toHaveBeenCalledWith('user-1', {
      localAddressBookId: 'book-1',
      uid: 'contact-uid',
      rawVCard: req.body,
    });
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('ETag', SERVED_ETAG);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 412 without delegation when If-None-Match requires an existing resource to be absent', async () => {
    mockResource();
    const res = response();

    await putHandler(request({ headers: { 'if-none-match': '*' } }), res);

    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
  });

  it('delegates an absent If-None-Match resource once with the create-only precondition', async () => {
    mockResource(null);
    mocks.createContactFromVCard.mockResolvedValueOnce({ etag: 'confirmed-etag' });
    const req = request({ headers: { 'if-none-match': ' * ' } });
    const res = response();

    await putHandler(req, res);

    expect(mocks.createContactFromVCard).toHaveBeenCalledTimes(1);
    expect(mocks.createContactFromVCard).toHaveBeenCalledWith('user-1', {
      localAddressBookId: 'book-1',
      uid: 'contact-uid',
      rawVCard: req.body,
      expectedAbsent: true,
    });
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('maps a typed local create-only failure to 412', async () => {
    mockResource(null);
    mocks.createContactFromVCard.mockRejectedValueOnce(Object.assign(
      new Error('The contact already exists'),
      { code: 'ERR_LOCAL_PRECONDITION_FAILED' },
    ));
    const res = response();

    await putHandler(request({ headers: { 'if-none-match': '*' } }), res);

    expect(res.status).toHaveBeenCalledWith(412);
    expect(res.end).toHaveBeenCalled();
  });

  it('returns 412 without delegation when If-Match does not match confirmed local state', async () => {
    mockResource();
    const res = response();

    await putHandler(request({ headers: { 'if-match': '"stale-etag"' } }), res);

    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
  });

  it('propagates an upstream failure without route-level local mutation', async () => {
    mockResource();
    mocks.replaceContactFromVCard.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }));
    const res = response();

    await putHandler(request({ headers: { 'if-match': SERVED_ETAG } }), res);

    expect(mocks.replaceContactFromVCard).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([
    ['ERR_CARDDAV_FINAL_FENCE'],
    ['ERR_CARDDAV_STALE_GENERATION'],
  ])('maps the self-healing %s race to a retriable 503 for external DAV clients', async code => {
    mockResource();
    mocks.replaceContactFromVCard.mockRejectedValueOnce(
      Object.assign(new Error('mapping changed after the remote write'), { code }),
    );
    const res = response();

    await putHandler(request({ headers: { 'if-match': SERVED_ETAG } }), res);

    expect(mocks.replaceContactFromVCard).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([
    ['ERR_CARDDAV_AMBIGUOUS_WRITE'],
    ['ERR_CARDDAV_PENDING_INTENT'],
  ])('maps the post-write %s to a non-retriable 409 for external DAV clients', async code => {
    mockResource();
    mocks.replaceContactFromVCard.mockRejectedValueOnce(
      Object.assign(new Error('post-write state is indeterminate'), { code }),
    );
    const res = response();

    await putHandler(request({ headers: { 'if-match': SERVED_ETAG } }), res);

    expect(mocks.replaceContactFromVCard).toHaveBeenCalledTimes(1);
    // 409 (not a retriable 5xx) so DAV clients refresh state instead of re-issuing
    // a mutation whose remote effect may already have landed.
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.end).toHaveBeenCalled();
  });
});

describe('DELETE CardDAV contact resource', () => {
  it.each([['absent', undefined], ['star', '*'], ['empty', '']])(
    'requires a real strong If-Match on a mapped DELETE (%s) → 428, nothing deleted',
    async (_kind, ifMatch) => {
      mockResource(servedContactRow({
        mapping_vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:Confirmed\r\nEND:VCARD\r\n',
      }));
      const res = response();

      await deleteHandler(request({ headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } }), res);

      expect(res.status).toHaveBeenCalledWith(428);
      expect(mocks.deleteContactFromVCard).not.toHaveBeenCalled();
    });

  it('delegates exactly once with matching local ETag', async () => {
    mockResource();
    mocks.deleteContactFromVCard.mockResolvedValueOnce({ ok: true });
    const res = response();

    await deleteHandler(request({ headers: { 'if-match': SERVED_ETAG } }), res);

    expect(mocks.deleteContactFromVCard).toHaveBeenCalledTimes(1);
    expect(mocks.deleteContactFromVCard).toHaveBeenCalledWith('user-1', {
      localAddressBookId: 'book-1',
      uid: 'contact-uid',
      expectedLocalEtag: 'local-etag',
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('returns 412 without delegation when If-Match is stale', async () => {
    mockResource();
    const res = response();

    await deleteHandler(request({ headers: { 'if-match': '"stale-etag"' } }), res);

    expect(mocks.deleteContactFromVCard).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(412);
  });

  it('propagates an upstream failure without route-level local mutation', async () => {
    mockResource();
    mocks.deleteContactFromVCard.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }));
    const res = response();

    await deleteHandler(request({ headers: { 'if-match': SERVED_ETAG } }), res);

    expect(mocks.deleteContactFromVCard).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([
    ['ERR_CARDDAV_AMBIGUOUS_WRITE'],
    ['ERR_CARDDAV_PENDING_INTENT'],
  ])('maps the post-write %s delete to a non-retriable 409 for external DAV clients', async code => {
    mockResource();
    mocks.deleteContactFromVCard.mockRejectedValueOnce(
      Object.assign(new Error('post-write state is indeterminate'), { code }),
    );
    const res = response();

    await deleteHandler(request({ headers: { 'if-match': SERVED_ETAG } }), res);

    expect(mocks.deleteContactFromVCard).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.end).toHaveBeenCalled();
  });
});

describe('CardDAV confirmed local reads', () => {
  it('GET keeps serving the confirmed local vCard and the presented ETag', async () => {
    const row = { vcard: 'BEGIN:VCARD\r\nUID:contact-uid\r\nFN:Confirmed\r\nEND:VCARD', etag: 'confirmed-etag' };
    mocks.query.mockResolvedValueOnce({ rows: [row] });
    const res = response();

    await getHandler(request(), res);

    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'text/vcard;charset=utf-8',
      'ETag': `"${presentedEtag(row)}"`,
    });
    expect(res.send).toHaveBeenCalledWith('BEGIN:VCARD\r\nUID:contact-uid\r\nFN:Confirmed\r\nEND:VCARD');
  });

  it.each([
    ['string', '🙂'.repeat(256 * 1024) + 'x'],
    ['Buffer', Buffer.alloc(1024 * 1024 + 1)],
  ])('rejects a REPORT %s body at 1 MiB + 1 before scanning it', async (_kind, body) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'book-1', sync_token: 'sync-1' }] });
    const res = response();

    await reportHandler(request({ body }), res);

    expect(res.status).toHaveBeenCalledWith(413);
    // The oversized body is rejected before any contact vCards are queried.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('rejects a multi-chunk REPORT body at 1 MiB + 1, then drains and detaches', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'book-1', sync_token: 'sync-1' }] });
    const req = streamingRequest((function* bodyChunks() {
      yield Buffer.alloc(1024 * 1024);
      yield Buffer.from('x');
      yield Buffer.from('tail');
    })());
    const ended = once(req, 'end');
    const res = response();

    await reportHandler(req, res);
    await ended;

    expect(res.status).toHaveBeenCalledWith(413);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(req.readableEnded).toBe(true);
    expect(req.listenerCount('data')).toBe(0);
  });

  it('GET serves the retained remote document overlaid with the local edit for a mapped contact', async () => {
    const row = {
      uid: 'contact-uid',
      display_name: 'Confirmed Local',
      first_name: null,
      last_name: null,
      emails: [{ value: 'mapped@example.test', type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photo_data: null,
      additional_fields: [],
      vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-uid\r\nFN:Confirmed Local\r\nEMAIL:mapped@example.test\r\nEND:VCARD\r\n',
      etag: 'confirmed-etag',
      mapping_vcard: [
        'BEGIN:VCARD', 'VERSION:3.0', 'UID:remote-uid-xyz', 'FN:Old Remote Name',
        'EMAIL:mapped@example.test', 'CATEGORIES:VIP,Board', 'X-CUSTOM-FLAG:keep-me',
        'TZ:America/New_York', 'END:VCARD', '',
      ].join('\r\n'),
    };
    mocks.query.mockResolvedValueOnce({ rows: [row] });
    const res = response();

    await getHandler(request(), res);

    // The served ETag derives from the presented document, not contacts.etag.
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'ETag': `"${presentedEtag(row)}"` }));
    const body = res.send.mock.calls[0][0];
    // The local modeled edit wins, the retained unmodeled properties are visible to
    // the client, and the served UID stays the local UID that keys the resource URL.
    expect(body).toContain('FN:Confirmed Local');
    expect(body).toContain('CATEGORIES:VIP,Board');
    expect(body).toContain('X-CUSTOM-FLAG:keep-me');
    expect(body).toContain('TZ:America/New_York');
    expect(body).toContain('UID:contact-uid');
    expect(body).not.toContain('remote-uid-xyz');
  });

  it('REPORT serves the retained remote document for a mapped contact', async () => {
    const row = {
      uid: 'contact-uid',
      display_name: 'Confirmed Local',
      first_name: null,
      last_name: null,
      emails: [{ value: 'mapped@example.test', type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photo_data: null,
      additional_fields: [],
      vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-uid\r\nFN:Confirmed Local\r\nEMAIL:mapped@example.test\r\nEND:VCARD\r\n',
      etag: 'confirmed-etag',
      mapping_vcard: [
        'BEGIN:VCARD', 'VERSION:3.0', 'UID:remote-uid-xyz', 'FN:Old Remote Name',
        'EMAIL:mapped@example.test', 'CATEGORIES:VIP,Board', 'END:VCARD', '',
      ].join('\r\n'),
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', sync_token: 'sync-1' }] })
      .mockResolvedValueOnce({ rows: [row] });
    const res = response();

    await reportHandler(request({ body: '<C:addressbook-query />' }), res);

    const xml = res.send.mock.calls[0][0];
    expect(xml).toContain(`<D:getetag>"${presentedEtag(row)}"</D:getetag>`);
    expect(xml).toContain('FN:Confirmed Local');
    expect(xml).toContain('CATEGORIES:VIP,Board');
  });

  it('REPORT keeps serving confirmed local address data and the presented ETag', async () => {
    const row = {
      uid: 'contact-uid',
      vcard: 'BEGIN:VCARD\r\nUID:contact-uid\r\nFN:Confirmed\r\nEND:VCARD',
      etag: 'confirmed-etag',
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', sync_token: 'sync-1' }] })
      .mockResolvedValueOnce({ rows: [row] });
    const res = response();

    await reportHandler(request({ body: '<C:addressbook-query />' }), res);

    const xml = res.send.mock.calls[0][0];
    expect(xml).toContain(`<D:getetag>"${presentedEtag(row)}"</D:getetag>`);
    expect(xml).toContain('FN:Confirmed');
    expect(mocks.createContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.replaceContactFromVCard).not.toHaveBeenCalled();
    expect(mocks.deleteContactFromVCard).not.toHaveBeenCalled();
  });
});
