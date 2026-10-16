// What frees a pooled connection whose command never gets a reply?
//
// makeClientCfg used to pass `commandTimeout: 30000`, and the pool's timings were built on
// it, but no imapflow release has that option. A server that read a command and never
// answered it was bounded only by socketTimeout, 5 minutes of silence, and the slot stayed
// taken for all of it. With a pool of one (Yahoo), every pooled operation on the account
// failed as busy meanwhile.
//
// These run a REAL ImapFlow against a local fake server, because the fix leans on
// imapflow internals (client.socket, client.socketTimeout) and on its socket-timeout
// handler: it has to tell an overdue command from a quiet but healthy session, and leave
// the lease's timer alone when it keeps that session with a NOOP. An upgrade that moves
// those internals, or whose handler puts socketTimeout back when it sends the NOOP, fails
// here. One that puts it back only while a fetch loop's body is busy on a row does not.
// Only time is faked: socket.setTimeout is scaled so the 45s stall timeout fires in
// milliseconds.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import net from 'node:net';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager, withFreshClient, evictPool, isConnectionRefusal, POOL_STALL_TIMEOUT_MS } from './imapManager.js';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const STALL_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Just enough IMAP for imapflow to log in, select INBOX, fetch and append. With stallFetch
// set, a FETCH is read and never answered, like a server that has hung; with resetFetch
// set, the connection is reset instead. appendAckMs delays the reply to an APPEND whose
// message has arrived in full, like a server that is slow to store it.
function startFakeImap() {
  const state = { stallFetch: false, resetFetch: false, appendAckMs: 0, appended: 0, commands: [], connections: 0, sockets: new Set() };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1] fake ready\r\n');
    let buffered = '';
    let literal = null; // an APPEND whose message is arriving: { tag, remaining }
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      for (;;) {
        if (literal?.remaining > 0) {
          const taken = Math.min(literal.remaining, buffered.length);
          literal.remaining -= taken;
          buffered = buffered.slice(taken);
          if (literal.remaining > 0) return;
        }
        const end = buffered.indexOf('\r\n');
        if (end < 0) return;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (literal) {
          // The CRLF that ends the APPEND command after its message.
          const { tag } = literal;
          literal = null;
          state.appended += 1;
          setTimeout(() => { if (!socket.destroyed) socket.write(`${tag} OK [APPENDUID 1 7] done\r\n`); }, state.appendAckMs);
          continue;
        }
        const [tag, command = '', sub = ''] = line.split(' ');
        const verb = command.toUpperCase() === 'UID' ? sub.toUpperCase() : command.toUpperCase();
        state.commands.push(verb);
        if (verb === 'SELECT' || verb === 'EXAMINE') {
          socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] done\r\n`);
        } else if (verb === 'LIST') {
          socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        } else if (verb === 'FETCH') {
          if (state.resetFetch) { socket.resetAndDestroy(); return; }
          if (!state.stallFetch) socket.write(`* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n${tag} OK done\r\n`);
        } else if (verb === 'APPEND') {
          literal = { tag, remaining: Number(/\{(\d+)\}$/.exec(line)[1]) };
          socket.write('+ go ahead\r\n');
        } else if (verb === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  return { server, state };
}

let fake;
let ACCOUNT;
const realSetTimeout = net.Socket.prototype.setTimeout;

beforeAll(async () => {
  fake = startFakeImap();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  ACCOUNT = {
    id: 'acct-stall',
    imap_host: '127.0.0.1',
    imap_port: fake.server.address().port,
    imap_tls: false,
    imap_skip_tls_verify: false,
    auth_user: 'user',
    auth_pass: 'enc',
  };
  vi.spyOn(net.Socket.prototype, 'setTimeout').mockImplementation(function (ms, ...rest) {
    return realSetTimeout.call(this, ms === POOL_STALL_TIMEOUT_MS ? STALL_MS : ms, ...rest);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => fake.server.close(resolve));
});

beforeEach(() => {
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  fake.state.stallFetch = false;
  fake.state.resetFetch = false;
  fake.state.appendAckMs = 0;
  fake.state.appended = 0;
  fake.state.commands = [];
  fake.state.connections = 0;
  // connectImapClient logs every client 'error'; the stall is expected to be one.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  for (const socket of fake.state.sockets) socket.destroy();
  console.error.mockRestore();
});

const fetchFlags = async (client) => {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const rows = [];
    for await (const msg of client.fetch('1', { uid: true, flags: true }, { uid: true })) rows.push(msg.uid);
    return rows;
  } finally {
    lock.release();
  }
};

describe('pooled command that never gets a reply', () => {
  it('closes the connection at the stall timeout instead of holding the slot for socketTimeout', async () => {
    fake.state.stallFetch = true;
    let stalledClient;
    const outcome = await Promise.race([
      withFreshClient(ACCOUNT, (client) => { stalledClient = client; return fetchFlags(client); })
        .then(() => 'answered', (err) => err),
      sleep(3000).then(() => 'still waiting'),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect(stalledClient.usable).toBe(false);
    // Named as a timeout, which fetchMessageBody retries, and not as imapflow's 'Connection
    // not available', which would read as the provider refusing connections. It says what
    // was measured rather than blaming the server, since a busy fetch loop body is silence too.
    expect(outcome.message).toMatch(/timed out/);
    expect(outcome.message).toBe(`IMAP command timed out: nothing received for ${POOL_STALL_TIMEOUT_MS / 1000}s`);
    expect(isConnectionRefusal(outcome.message)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMAP error'), 'Socket timeout');

    // The slot is free: the next pooled operation gets a new connection that works.
    fake.state.stallFetch = false;
    let nextClient;
    const rows = await withFreshClient(ACCOUNT, (client) => { nextClient = client; return fetchFlags(client); });
    expect(rows).toEqual([1]);
    expect(nextClient).not.toBe(stalledClient);
    expect(fake.state.connections).toBe(2);
  });

  it('keeps a lease that is quiet while holding a mailbox lock, and still closes a stall after it', async () => {
    // Between two commands (a DB write, say) nothing is owed, so a quiet socket is no
    // stall: imapflow answers the timer with a NOOP rather than closing. The stall timeout
    // has to outlast that NOOP, or the rest of the lease would be back on socketTimeout.
    const seen = {};
    const outcome = await Promise.race([
      withFreshClient(ACCOUNT, async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          await sleep(STALL_MS * 4);
          seen.usable = client.usable;
          seen.noop = fake.state.commands.includes('NOOP');
          fake.state.stallFetch = true;
          for await (const msg of client.fetch('1', { uid: true, flags: true }, { uid: true })) seen.row = msg.uid;
        } finally {
          lock.release();
        }
      }).then(() => 'answered', (err) => err),
      sleep(3000).then(() => 'still waiting'),
    ]);

    expect(seen).toEqual({ usable: true, noop: true });
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toMatch(/timed out/);
  });

  it('puts the normal timeout back when the lease ends', async () => {
    // An unused pooled connection with no mailbox selected is closed when its timer
    // fires, so leaving the stall timeout on it would throw away pooled sessions (the
    // pre-warmed one among them) and cost a fresh login on the next operation.
    let leased;
    await withFreshClient(ACCOUNT, async (client) => { leased = client; });
    const errorListeners = leased.listenerCount('error');
    await sleep(STALL_MS * 4);

    expect(leased.usable).toBe(true);
    // The spy scales only the stall timeout, so the restored value reads as it was set.
    expect(leased.socket.timeout).toBe(leased.socketTimeout);
    let reused;
    await withFreshClient(ACCOUNT, async (client) => { reused = client; });
    expect(reused).toBe(leased);
    expect(fake.state.connections).toBe(1);
    // Each lease takes its listener away again, or a long-lived pooled client collects them.
    expect(reused.listenerCount('error')).toBe(errorListeners);
  });

  it('does not call a connection dropped for another reason a timeout', async () => {
    fake.state.resetFetch = true;
    const outcome = await withFreshClient(ACCOUNT, fetchFlags).then(() => 'answered', (err) => err);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMAP error'), expect.stringMatching(/ECONNRESET/));
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).not.toMatch(/timed out/);
  });

  it('leaves an APPEND on the normal timeout, because the server is quiet while it stores the message', async () => {
    // Node counts an upload as activity only while part of it is still queued in the
    // process, so the tail draining from the kernel's send buffer, and the server storing
    // the message, are silence to the timer. Here the server takes 3x the stall timeout to
    // acknowledge a message it has received in full.
    fake.state.appendAckMs = STALL_MS * 3;
    const manager = Object.create(ImapManager.prototype);
    const result = await manager.appendToFolder(ACCOUNT, 'Sent', Buffer.from('Subject: hi\r\n\r\nhello\r\n'), ['\\Seen']);

    expect(result).toEqual({ uid: 7, folder: 'Sent' });
    expect(fake.state.appended).toBe(1);
  });
});
