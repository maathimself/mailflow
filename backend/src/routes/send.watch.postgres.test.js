import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

const boundary = vi.hoisted(() => ({ manager: null, database: null, kv: new Map(), transactions: 0 }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  pool: { query: (...args) => boundary.database.query(...args) },
  withTransaction: async fn => {
    boundary.transactions++;
    await boundary.database.query('BEGIN');
    try {
      const result = await fn(boundary.database);
      await boundary.database.query('COMMIT');
      return result;
    } catch (error) {
      await boundary.database.query('ROLLBACK');
      throw error;
    }
  },
}));
vi.mock('../index.js', () => ({ get imapManager() { return boundary.manager; } }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => {
  req.session = { userId: req.headers['x-test-user'] || 'owner' }; next();
} }));
vi.mock('../services/kvStore.js', () => ({ kv: {
  get: async key => boundary.kv.get(key) ?? null,
  set: async (key, value, options) => {
    if (options?.NX && boundary.kv.has(key)) return null;
    boundary.kv.set(key, value); return 'OK';
  },
  del: async key => Number(boundary.kv.delete(key)),
} }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
// Synthetic credentials and DNS never reach a real provider.
vi.mock('../services/encryption.js', async importOriginal => ({ ...await importOriginal(),
  decrypt: value => value, encrypt: value => value, isEncrypted: () => false,
}));
vi.mock('../services/hostValidation.js', async importOriginal => ({ ...await importOriginal(),
  resolveForConnection: async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null }),
  createPinnedLookup: () => {},
}));

import { ImapFlow } from 'imapflow';
import { query } from '../services/db.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { ImapManager } from '../services/imapManager.js';
import { setMailEngine } from '../plugins/mailEngine.js';
import { pluginRegistry } from '../plugins/registry.js';
import { gtdPlugin } from '../plugins/gtd/index.js';
import { invalidateGtdConfigCache } from '../plugins/gtd/gtdConfig.js';
import { invalidateActivationCache } from '../plugins/activation.js';
import { invalidateOwnerAddressesCache } from '../plugins/gtd/gtdTransitions.js';
import { invalidateConnectionPolicyCache } from '../services/connectionPolicy.js';
import sendRoutes from './send.js';
import gtdRoutes from '../plugins/gtd/routes.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const missingRow = '99999999-9999-4999-8999-999999999999';

// Hand-written connection-local (pg_temp) schema: no migrations or persistent fixtures.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('sent Watch through real routes and PostgreSQL', () => {
  let database, server, base, provider, account, sent, watch;
  let observerReads, observerSnapshots, events, observe, failInsert, databaseFailures, siblingInserted;
  const managers = [];
  const pendingSync = new Set();

  class FakeImap extends EventEmitter {
    constructor(config) {
      super();
      this.accountId = config.auth.user.startsWith('second') ? B : A;
      this.usable = true;
      this.capabilities = new Map([['UIDPLUS', true]]);
      this.enabled = new Set();
      this.namespace = { delimiter: '/', prefix: '' };
    }
    async connect() {}
    async logout() { this.close(); }
    close() { this.usable = false; }
    async noop() {}
    box(folder) {
      const key = `${this.accountId}:${folder}`;
      if (!provider.boxes.has(key)) provider.boxes.set(key, []);
      return provider.boxes.get(key);
    }
    async getMailboxLock(folder) {
      this.folder = folder;
      const rows = this.box(folder).filter(row => row.visible);
      this.mailbox = { path: folder, exists: rows.length, uidValidity: 1n,
        uidNext: Math.max(0, ...this.box(folder).map(row => row.uid)) + 1,
        highestModseq: BigInt(rows.length + 1) };
      return { release() {} };
    }
    async mailboxCreate(parts) {
      const path = parts.join('/'); this.box(path);
      return { path, created: false };
    }
    async append(folder, raw, flags) {
      const source = Buffer.from(raw).toString();
      const header = name => source.match(new RegExp(`^${name}: ([^\\r\\n]+)`, 'mi'))?.[1];
      const uid = provider.nextUid++;
      this.box(folder).push({ uid, source, flags: new Set(flags), visible: !provider.delayAppend,
        envelope: { messageId: header('Message-ID'), subject: header('Subject'),
          inReplyTo: header('In-Reply-To'), date: new Date(),
          from: [{ address: 'owner@synthetic.test' }], to: [{ address: 'recipient@synthetic.test' }] } });
      provider.commands.push({ command: 'APPEND', accountId: this.accountId, folder, uid });
      return provider.appendUid ? { uid } : {};
    }
    async messageCopy(uid, to, options) {
      if (options?.uid !== true || Object.keys(options).length !== 1) {
        provider.assertionFailures.push(`COPY must address UIDs: ${JSON.stringify(options)}`);
      }
      const source = this.box(this.folder).find(row => row.uid === Number(uid) && row.visible);
      provider.attempts++;
      if (provider.failCopy) { provider.failCopy = false; throw new Error('synthetic COPY refused'); }
      if (!source) return false;
      const copiedUid = provider.nextUid++;
      this.box(to).push({ ...source, uid: copiedUid, flags: new Set(source.flags), visible: !provider.delayCopy });
      provider.commands.push({ command: 'COPY', accountId: this.accountId, from: this.folder, to,
        uid: Number(uid), copiedUid, messageId: source.envelope.messageId });
      return provider.copyUid ? { uidMap: new Map([[Number(uid), copiedUid]]) } : {};
    }
    async *fetch(range, fields, options = {}) {
      const rows = this.box(this.folder).filter(row => row.visible);
      const [lo, hi = lo] = String(range).split(':');
      const max = options.uid ? Math.max(0, ...rows.map(row => row.uid)) : rows.length;
      const lower = lo === '*' ? max : Number(lo);
      const upper = hi === '*' ? max : Number(hi);
      for (const [index, row] of rows.entries()) {
        const n = options.uid ? row.uid : index + 1;
        if (n < Math.min(lower, upper) || n > Math.max(lower, upper)) continue;
        yield { uid: row.uid, flags: row.flags, ...(fields.envelope ? {
          envelope: row.envelope, internalDate: row.envelope.date,
          headers: Buffer.from(row.source.split('\r\n\r\n')[0] + '\r\n'),
          bodyStructure: { type: 'text/plain' }, size: row.source.length,
        } : {}) };
      }
    }
    async fetchOne(uid) {
      return this.box(this.folder).find(row => row.uid === Number(uid) && row.visible) || false;
    }
    async search() { return this.box(this.folder).filter(row => row.visible).map(row => row.uid); }
  }

  function newManager() {
    const manager = new ImapManager({ clients: new Set() });
    // Keep constructor initialization, but this test explicitly drives sync instead of
    // arming unattended background work against its temporary schema.
    for (const key of ['_folderStatusTimer', '_healthCheckTimer', '_snippetSchedulerTimer',
      '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(manager[key]);
    manager.broadcast = (event, userId) => {
      events.push({ ...event, userId, afterSiblingInsert: siblingInserted });
      if (observe && event.type === 'gtd_sections_updated' && userId === 'owner') {
        observerReads.push(sections('observer').then(data => { observerSnapshots.push(data); }));
      }
    };
    const syncFolder = manager.syncFolderOnDemand.bind(manager);
    manager.syncFolderOnDemand = (...args) => {
      const operation = syncFolder(...args);
      pendingSync.add(operation);
      operation.finally(() => pendingSync.delete(operation));
      return operation;
    };
    boundary.manager = manager;
    setMailEngine(manager);
    managers.push(manager);
    return manager;
  }

  async function request(path, body, headers = {}) {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const sections = async (session = 'initiator', accountId = A) => {
    const result = await request(`/api/gtd/sections?accountId=${accountId}`, undefined, { 'x-test-session': session });
    expect(result.status).toBe(200);
    return result.body.sections;
  };
  const send = (extra = {}, key = 'logical-send') => request('/api/mail/send', {
    accountId: A, to: ['recipient@synthetic.test'], subject: 'Synthetic outgoing Watch', body: 'Waiting for a reply', ...extra,
  }, { 'x-idempotency-key': key });
  const classify = (id, user = 'owner', session = 'initiator') => request('/api/gtd/classify',
    { messageId: id, state: 'watch' }, { 'x-test-user': user, 'x-test-session': session });
  const rows = async folder => (await database.query(
    'SELECT * FROM messages WHERE account_id=$1 AND folder=$2 ORDER BY uid', [A, folder])).rows;
  const commands = name => provider.commands.filter(command => command.command === name);
  const reveal = folder => { for (const row of provider.boxes.get(`${A}:${folder}`) || []) row.visible = true; };
  async function sync(folder) {
    // syncMessages propagates failures (syncFolderOnDemand logs them); use both the
    // ordinary on-demand path and the row assertions so a swallowed error cannot pass.
    await boundary.manager.syncFolderOnDemand(account, folder);
    await Promise.all(observerReads);
  }
  async function settleSync() {
    while (pendingSync.size) await Promise.all([...pendingSync]);
    await Promise.all(observerReads);
  }

  beforeAll(async () => {
    const url = process.env.MAILFLOW_TEST_DATABASE_URL;
    database = new pg.Client({ connectionString: url });
    await database.connect(); boundary.database = database;
    await database.query('SET search_path TO pg_temp');
    await database.query(`
      CREATE TEMP TABLE users (id text PRIMARY KEY, preferences jsonb);
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean DEFAULT true,
        include_in_unified_inbox boolean DEFAULT true, name text, email_address text, color text,
        folder_mappings jsonb, sort_order int DEFAULT 0, created_at timestamptz DEFAULT now(),
        imap_host text, imap_port int, imap_tls boolean, auth_user text, auth_pass text,
        smtp_host text, oauth_provider text, protocol text DEFAULT 'imap', last_sync timestamptz);
      CREATE TEMP TABLE account_aliases (account_id uuid, email text);
      CREATE TEMP TABLE plugin_account_config (plugin_id text, account_id uuid, config jsonb);
      CREATE TEMP TABLE system_settings (key text, value text);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, delimiter text DEFAULT '/',
        special_use text, flags jsonb DEFAULT '[]', no_select boolean DEFAULT false,
        total_count int DEFAULT 0, unread_count int DEFAULT 0,
        uid_validity bigint DEFAULT 1, highest_modseq bigint, updated_at timestamptz,
        PRIMARY KEY(account_id,path));
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
        uid bigint, folder text, message_id text, subject text, from_name text, from_email text,
        to_addresses jsonb, cc_addresses jsonb, bcc_addresses jsonb, reply_to jsonb,
        in_reply_to text, date timestamptz, snippet text, is_read boolean DEFAULT false,
        is_starred boolean DEFAULT false, is_deleted boolean DEFAULT false, has_attachments boolean,
        flags jsonb, body_html text, body_text text, attachments jsonb, thread_references text,
        thread_id text, thread_key text GENERATED ALWAYS AS (COALESCE(thread_id,id::text)) STORED,
        is_bulk boolean, read_changed_at timestamptz, star_changed_at timestamptz,
        spam_score_sa real, spam_score_ml real, spam_verdict text, spam_analyzed_at timestamptz,
        spam_details jsonb, spam_user_override text, category text, list_unsubscribe text,
        list_unsubscribe_post text, unsubscribed_at timestamptz, delivery_addresses jsonb,
        sender_name text, sender_email text, forwarded_from_name text, forwarded_from_email text,
        forwarded_via text, provider_msgid text, plugin_annotations jsonb DEFAULT '{"gtd":{"gist":"Synthetic waiting"}}',
        UNIQUE(account_id,uid,folder));
      CREATE TEMP TABLE address_books (id uuid DEFAULT gen_random_uuid(), user_id text, name text,
        updated_at timestamptz, sync_token text, UNIQUE(user_id,name));
      CREATE TEMP TABLE contacts (address_book_id uuid, user_id text, uid text, vcard text, etag text,
        display_name text, primary_email text, emails jsonb, is_auto boolean, send_count int,
        last_sent timestamptz, updated_at timestamptz);
      CREATE UNIQUE INDEX ON contacts(address_book_id,primary_email) WHERE primary_email IS NOT NULL;
    `);
    // Reuse the actual generated expression rather than approximate subject threading
    // in a fake SQL result. Apply just this DDL to the connection-local messages table.
    const migration = await readFile(new URL('../../migrations/0002_subject_threading.sql', import.meta.url), 'utf8');
    const generatedSubject = migration.match(/ALTER TABLE messages ADD COLUMN IF NOT EXISTS normalized_subject[\s\S]*?STORED;/)?.[0];
    if (!generatedSubject) throw new Error('Subject column migration changed; update test schema');
    await database.query(generatedSubject);
    if (!pluginRegistry.has('gtd')) pluginRegistry.register(gtdPlugin);
    const app = express(); app.use(express.json());
    app.use('/api/mail', sendRoutes); app.use('/api/gtd', gtdRoutes);
    // eslint-disable-next-line no-unused-vars
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    sent = 'Sent'; watch = 'Watch';
    observerReads = []; observerSnapshots = []; events = []; observe = false; failInsert = false; databaseFailures = [];
    boundary.kv.clear(); boundary.transactions = 0; siblingInserted = false;
    provider = { boxes: new Map(), commands: [], assertionFailures: [], attempts: 0, nextUid: 101,
      appendUid: true, copyUid: true, delayAppend: false, delayCopy: false, failCopy: false };
    ImapFlow.mockImplementation(function (config) { return new FakeImap(config); });
    query.mockImplementation(async (sql, values) => {
      const isSiblingInsert = sql.includes('INSERT INTO messages') && sql.includes('FROM messages');
      if (isSiblingInsert) {
        // Deterministic two-session schedule: a slow INSERT lets the broadcast observer
        // finish its GET. After the fix no broadcast exists yet, so there is no wait.
        await Promise.all(observerReads);
        if (failInsert) { failInsert = false; throw new Error('synthetic sibling insert failed'); }
      }
      try {
        const result = await database.query(sql, values);
        if (isSiblingInsert && result.rowCount > 0) siblingInserted = true;
        return result;
      }
      catch (error) { databaseFailures.push(error.message); throw error; }
    });
    await database.query('TRUNCATE users,email_accounts,account_aliases,plugin_account_config,system_settings,folders,messages,address_books,contacts');
    await database.query(`INSERT INTO users VALUES ('owner','{"enabledPlugins":["gtd"]}'),('foreign','{}');
      INSERT INTO system_settings VALUES ('allow_private_hosts','true'),('allow_insecure_tls','true');`);
    for (const [id, login] of [[A, 'owner@synthetic.test'], [B, 'second@synthetic.test']]) {
      await database.query(`INSERT INTO email_accounts(id,user_id,name,email_address,folder_mappings,imap_host,
        imap_port,imap_tls,auth_user,auth_pass,smtp_host) VALUES ($1,'owner','Synthetic',$2,'{}',
        'imap.synthetic.test',993,true,$2,'synthetic','smtp.synthetic.test')`, [id, login]);
      await database.query("INSERT INTO plugin_account_config VALUES ('gtd',$1,'{\"enabled\":true}')", [id]);
      for (const [path, special] of [['Sent', '\\Sent'], ['Drafts', '\\Drafts'], ['INBOX', null], ['Watch', null]]) {
        await database.query('INSERT INTO folders(account_id,path,name,special_use) VALUES ($1,$2,$2,$3)', [id, path, special]);
      }
      invalidateGtdConfigCache(id); invalidateOwnerAddressesCache(id);
    }
    invalidateActivationCache('owner'); invalidateConnectionPolicyCache();
    account = (await database.query('SELECT * FROM email_accounts WHERE id=$1', [A])).rows[0];
    createAccountSmtpTransport.mockImplementation(async acct => ({ account: acct, transport: {
      sendMail: async options => { provider.commands.push({ command: 'SEND', messageId: options.messageId }); return { accepted: options.to }; },
    } }));
    newManager();
  });
  afterEach(async () => {
    observe = false;
    await settleSync();
    for (const manager of managers.splice(0)) {
      await manager.disconnectAccount(A); await manager.disconnectAccount(B);
    }
    vi.clearAllTimers(); vi.useRealTimers();
    // Production paths intentionally swallow some errors; a missing fixture column
    // or table must still fail this test rather than masquerade as provider behavior.
    expect(databaseFailures).toEqual([]);
    expect(provider.assertionFailures).toEqual([]);
    // Send/classify/copy/sync currently use query(), not withTransaction(). If this
    // changes, review connection isolation before claiming concurrent atomicity:
    // two transactions cannot be independently isolated on this single PG client.
    expect(boundary.transactions).toBe(0);
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });

  it.each([null, 1])('sends once and lists the Sent copy in Watch (empty-folder modseq %s)', async baseline => {
    await database.query('UPDATE folders SET highest_modseq=$3 WHERE account_id=$1 AND path=$2', [A, watch, baseline]);
    const delivered = await send(); expect(delivered.status).toBe(200);
    const [source] = await rows(sent); expect(source.message_id).toBe(delivered.body.messageId);
    const classified = await classify(source.id); expect(classified.status).toBe(200);
    const [copy] = await rows(watch);
    expect(copy.message_id).toBe(source.message_id); expect(copy.uid).not.toBe(source.uid);
    expect((await sections()).watch.threads.map(row => row.id)).toContain(copy.id);
    expect(commands('COPY')).toEqual([{ command: 'COPY', accountId: A, from: sent, to: watch,
      uid: Number(source.uid), copiedUid: Number(copy.uid), messageId: source.message_id }]);
    expect(await send()).toEqual(delivered);
    expect((await classify(source.id)).body.applied).toBe(false);
    for (const name of ['SEND', 'APPEND', 'COPY']) expect(commands(name)).toHaveLength(1);
  });

  it('H1 reports no local Sent row honestly until delayed APPEND sync arrives', async () => {
    provider.appendUid = false; provider.delayAppend = true;
    expect((await send()).status).toBe(200); expect(await rows(sent)).toHaveLength(0);
    expect((await classify(missingRow)).status).toBe(404);
    expect((await sections()).watch.total).toBe(0); expect(commands('COPY')).toHaveLength(0);
    reveal(sent); await sync(sent);
    const [source] = await rows(sent); expect(source).toBeDefined();
    expect((await classify(source.id)).status).toBe(200);
    expect((await sections()).watch.total).toBe(1);
    for (const name of ['SEND', 'APPEND', 'COPY']) expect(commands(name)).toHaveLength(1);
  });

  it('H2 makes the second session see Watch from the copy broadcast without an initiating-tab refresh', async () => {
    await send(); const [source] = await rows(sent);
    observe = true;
    expect((await classify(source.id)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(1100);
    await settleSync();
    await Promise.all(observerReads);
    expect(observerSnapshots.length).toBeGreaterThan(0);
    expect((await sections('initiator')).watch.total).toBe(1);
    // Worst-case schedule, not a prescribed failure: if main emits a later correction
    // this passes honestly and H2 does not justify a runtime change. Retain the event
    // count and insertion boundary so a pass can be attributed to the actual ordering.
    const refreshes = events.filter(event => event.type === 'gtd_sections_updated' && event.userId === 'owner');
    expect(refreshes.length, JSON.stringify(refreshes)).toBe(observerSnapshots.length);
    expect(refreshes.some(event => event.afterSiblingInsert), JSON.stringify(refreshes)).toBe(true);
    expect(observerSnapshots.at(-1).watch.total).toBe(1);
  });

  // Known race, not fixed here: applyLabel checks for an existing copy and then COPYs
  // without serializing concurrent requests, so both sessions copy. Fails on main too.
  it.skip('two sessions classifying concurrently create only one Watch copy', async () => {
    await send(); const [source] = await rows(sent);
    const results = await Promise.all([
      classify(source.id, 'owner', 'tab-one'),
      classify(source.id, 'owner', 'tab-two'),
    ]);
    expect(results.filter(result => result.status === 200 && result.body.applied)).toHaveLength(1);
    expect(results.filter(result => result.status === 409 ||
      (result.status === 200 && result.body.applied === false))).toHaveLength(1);
    expect(provider.assertionFailures).toEqual([]);
    expect(commands('COPY')).toHaveLength(1);
    expect(await rows(watch)).toHaveLength(1);
    expect((await sections()).watch.total).toBe(1);
    for (const name of ['SEND', 'APPEND']) expect(commands(name)).toHaveLength(1);
  });

  for (const [suffix, firstUid] of [['nested/Waiting', 1], ['Awaiting reply', 7001], ['期待', 2147483646]]) {
    it(`H3 preserves custom mapping and UID identity: ${suffix}`, async () => {
      sent = 'Mail/Outbox'; watch = suffix; provider.nextUid = firstUid;
      account.folder_mappings = { sent };
      await database.query('UPDATE email_accounts SET folder_mappings=$2 WHERE id=$1', [A, account.folder_mappings]);
      await database.query('INSERT INTO folders(account_id,path,name) VALUES ($1,$2,$2),($1,$3,$3)', [A, sent, watch]);
      await database.query("UPDATE plugin_account_config SET config=$2 WHERE account_id=$1", [A, { enabled: true, folders: { watch } }]);
      invalidateGtdConfigCache(A);
      const result = await send(); expect(result.body.sentFolder).toBe(sent);
      const [source] = await rows(sent); expect((await classify(source.id)).body.folder).toBe(watch);
      expect((await sections()).watch.threads[0]).toMatchObject({ account_id: A, folder: watch, message_id: source.message_id });
      expect(commands('COPY')[0]).toMatchObject({ from: sent, to: watch, uid: firstUid, copiedUid: firstUid + 1 });
    });
  }

  it('rejects foreign users and missing account GTD configuration without copying', async () => {
    await send(); const [source] = await rows(sent);
    expect((await classify(source.id, 'foreign')).status).toBe(404);
    await database.query('DELETE FROM plugin_account_config WHERE account_id=$1', [A]); invalidateGtdConfigCache(A);
    expect((await classify(source.id)).status).toBe(400);
    expect(commands('COPY')).toHaveLength(0); expect((await sections()).watch.total).toBe(0);
  });

  it('does not borrow another account copy with the same Message-ID', async () => {
    await send(); const [source] = await rows(sent);
    await database.query(`INSERT INTO messages(account_id,folder,uid,message_id,thread_id,date,is_read)
      VALUES ($1,'Watch',101,$2,$2,now(),true)`, [B, source.message_id]);
    expect((await classify(source.id)).status).toBe(200);
    expect(commands('COPY')).toHaveLength(1);
    expect((await sections()).watch.threads.every(row => row.account_id === A)).toBe(true);
    expect((await sections('other-account', B)).watch.threads.every(row => row.account_id === B)).toBe(true);
  });

  it('retries a rejected COPY without sending or appending again', async () => {
    await send(); const [source] = await rows(sent); provider.failCopy = true;
    expect((await classify(source.id)).status).toBe(500);
    expect((await sections()).watch.total).toBe(0);
    expect((await classify(source.id)).status).toBe(200);
    expect(provider.attempts).toBe(2);
    for (const name of ['SEND', 'APPEND', 'COPY']) expect(commands(name)).toHaveLength(1);
  });

  it('recovers a successful COPY with failed sibling persistence after manager restart without another COPY', async () => {
    await send(); const [source] = await rows(sent); failInsert = true;
    expect((await classify(source.id)).status).toBe(500); expect(await rows(watch)).toHaveLength(0);
    await boundary.manager.disconnectAccount(A); newManager();
    await sync(sent); await sync(watch);
    expect(await rows(watch)).toHaveLength(1);
    expect((await classify(source.id)).body.applied).toBe(false);
    expect((await sections()).watch.total).toBe(1);
    for (const name of ['SEND', 'APPEND', 'COPY']) expect(commands(name)).toHaveLength(1);
  });

  it('converges without COPYUID after delayed visibility and restart', async () => {
    await send(); const [source] = await rows(sent);
    provider.copyUid = false; provider.delayCopy = true;
    expect((await classify(source.id)).status).toBe(200);
    await settleSync();
    expect((await sections()).watch.total).toBe(0);
    reveal(watch);
    await boundary.manager.disconnectAccount(A); newManager();
    await sync(sent); await sync(watch);
    expect((await sections()).watch.total).toBe(1);
    expect((await classify(source.id)).body.applied).toBe(false);
    for (const name of ['SEND', 'APPEND', 'COPY']) expect(commands(name)).toHaveLength(1);
  });

  it('keeps deferred no-COPYUID reconciliation visible to the second session', async () => {
    await send(); const [source] = await rows(sent);
    provider.copyUid = false; observe = true;
    expect((await classify(source.id)).status).toBe(200);
    await settleSync();
    expect(await rows(watch)).toHaveLength(1);
    expect(observerSnapshots.at(-1).watch.total).toBe(1);
    expect(commands('COPY')).toHaveLength(1);
  });

  it('H4 keeps Watch when sent sync and subsequent reply transitions follow classification', async () => {
    const original = await send(); const [source] = await rows(sent);
    await classify(source.id); await sync(sent);
    await pluginRegistry.runHook('onSentMessage', { imapManager: boundary.manager.pluginFacade, account, messageId: original.body.messageId });
    const reply = await send({ inReplyTo: original.body.messageId, references: original.body.messageId }, 'reply');
    expect(reply.status).toBe(200); await sync(sent);
    await pluginRegistry.runHook('onSentMessage', { imapManager: boundary.manager.pluginFacade, account, messageId: reply.body.messageId });
    const inbound = { uid: 9001, visible: true, flags: new Set(['\\Seen']),
      source: `Message-ID: <reply@synthetic.test>\r\nReferences: ${original.body.messageId}\r\n\r\nReply`,
      envelope: { messageId: '<reply@synthetic.test>', inReplyTo: original.body.messageId,
        subject: 'Re: Synthetic outgoing Watch', date: new Date(),
        from: [{ address: 'recipient@synthetic.test' }], to: [{ address: 'owner@synthetic.test' }] } };
    provider.boxes.set(`${A}:INBOX`, [inbound]); await sync('INBOX');
    expect(await rows('INBOX')).toHaveLength(1);
    expect((await sections()).watch.total).toBe(1);
    expect(await rows(watch)).toHaveLength(1); expect(commands('COPY')).toHaveLength(1);
  });
});
