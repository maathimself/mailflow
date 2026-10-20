import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'fs/promises';
import pg from 'pg';

const MIGRATION = new URL('../../migrations/0068_split_same_sender_subject_threads.sql', import.meta.url);

// Migration 0068 (#649): subject-grouped threads that collected every receipt or alert from
// one sender are split, while header threading and genuine header-less reply chains stay.
// Uses only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('split same-sender subject threads (#649)', () => {
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const OWNER = 'me@example.com';
  let database;
  let nextId = 1;

  const insert = (rows) => Promise.all(rows.map(r => database.query(
    `INSERT INTO messages (id, account_id, folder, message_id, thread_id, subject, from_email,
       to_addresses, cc_addresses, in_reply_to, thread_references, is_bulk, is_deleted, date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [`00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, ACCOUNT, r.folder ?? 'INBOX',
      r.mid, r.thread, r.subject, r.from, JSON.stringify(r.to ?? [{ email: OWNER }]),
      JSON.stringify(r.cc ?? []), r.inReplyTo ?? null, r.refs ?? null, r.bulk ?? null,
      r.deleted ?? false, r.date ?? '2026-10-01T00:00:00Z'],
  )));
  const threads = async () => Object.fromEntries((await database.query(
    'SELECT folder, message_id, is_deleted, thread_id FROM messages ORDER BY message_id, folder, is_deleted',
  )).rows.map(r => [`${r.message_id}${r.folder === 'INBOX' ? '' : ` ${r.folder}`}${r.is_deleted ? ' deleted' : ''}`, r.thread_id]));
  const migrate = async () => database.query(await readFile(MIGRATION, 'utf8'));

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query(`
      DROP TABLE IF EXISTS pg_temp.messages, pg_temp.email_accounts, pg_temp.account_aliases;
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, email_address text);
      CREATE TEMP TABLE account_aliases (account_id uuid, email text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text, message_id text,
        thread_id text, subject text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        in_reply_to text, thread_references text, is_bulk boolean, is_deleted boolean DEFAULT false,
        date timestamptz)`);
    await database.query('INSERT INTO email_accounts VALUES ($1, $2)', [ACCOUNT, OWNER]);
    await database.query('INSERT INTO account_aliases VALUES ($1, $2)', [ACCOUNT, 'support@example.com']);
  });

  it('splits a same-sender chain of identical subjects, every copy included', async () => {
    const subject = 'Order Confirmation for Eldridge from King David';
    await insert([
      { mid: '<d1>', thread: '<d1>', subject, from: 'no-reply@doordash.com' },
      { mid: '<d2>', thread: '<d1>', subject, from: 'no-reply@doordash.com' },
      { mid: '<d3>', thread: '<d1>', subject, from: 'no-reply@doordash.com' },
      { mid: '<d3>', thread: '<d1>', subject, from: 'no-reply@doordash.com', folder: 'Archive' },
      { mid: '<d3>', thread: '<d1>', subject, from: 'no-reply@doordash.com', folder: 'Trash', deleted: true },
      // Not a no-reply address, and not bulk: the missing reply prefix alone splits these.
      { mid: '<s1>', thread: '<s1>', subject: 'Your statement', from: 'statements@bank.example' },
      { mid: '<s2>', thread: '<s1>', subject: 'Your statement', from: 'Statements@Bank.example' },
      // Addressed to the sender itself, as bulk mail often is: no exchange.
      { mid: '<w1>', thread: '<w1>', subject: 'Weekly digest', from: 'digest@news.example', to: [{ email: 'digest@news.example' }] },
      { mid: '<w2>', thread: '<w1>', subject: 'Weekly digest', from: 'digest@news.example', to: [{ email: 'digest@news.example' }] },
    ]);

    await migrate();

    expect(await threads()).toEqual({
      '<d1>': '<d1>', '<d2>': '<d2>', '<d3>': '<d3>', '<d3> Archive': '<d3>', '<d3> Trash deleted': '<d3>',
      '<s1>': '<s1>', '<s2>': '<s2>', '<w1>': '<w1>', '<w2>': '<w2>',
    });
  });

  it('keeps a header-less Outlook reply chain and a prefixed follow-up from the same sender', async () => {
    await insert([
      { mid: '<o1>', thread: '<o1>', subject: 'Project update', from: 'anna@partner.com' },
      { mid: '<o2>', thread: '<o1>', subject: 'RE: Project update', from: OWNER, to: [{ email: 'anna@partner.com' }] },
      { mid: '<o3>', thread: '<o1>', subject: 'RE: RE: Project update', from: 'anna@partner.com' },
      { mid: '<o4>', thread: '<o1>', subject: 'AW: Project update', from: 'anna@partner.com' },
      // An exchange that kept the subject: Bob answers a message he was copied on.
      { mid: '<q1>', thread: '<q1>', subject: 'Quarterly numbers', from: 'anna@partner.com', cc: [{ email: 'bob@partner.com' }] },
      { mid: '<q2>', thread: '<q1>', subject: 'Quarterly numbers', from: 'bob@partner.com', to: [{ email: 'anna@partner.com' }] },
    ]);
    const before = await threads();

    await migrate();

    expect(await threads()).toEqual(before);
  });

  it('keeps header replies with the message they were threaded through', async () => {
    await insert([
      { mid: '<r1>', thread: '<r1>', subject: 'Weekly report', from: 'boss@corp.example' },
      // Header replies from a colleague, addressed to the account only, so that they are no
      // exchange with the boss's messages.
      { mid: '<h1>', thread: '<r1>', subject: 'Re: Weekly report', from: 'colleague@corp.example', inReplyTo: '<r1>', refs: '<r1>' },
      // Joined by subject alone: moves, and the replies threaded through it move with it,
      // including a reply to a reply that names only its parent.
      { mid: '<r2>', thread: '<r1>', subject: 'Weekly report', from: 'boss@corp.example' },
      { mid: '<h2>', thread: '<r1>', subject: 'Re: Weekly report', from: 'colleague@corp.example', inReplyTo: '<r2>', refs: '<r2>' },
      { mid: '<h3>', thread: '<r1>', subject: 'Re: Weekly report', from: 'colleague@corp.example', inReplyTo: '<h2>' },
      // Names <r3>, but computeThreadId threads it by its first reference, <r1>: it stays and
      // <r3> moves alone.
      { mid: '<r3>', thread: '<r1>', subject: 'Weekly report', from: 'boss@corp.example' },
      { mid: '<h4>', thread: '<r1>', subject: 'Re: Weekly report', from: 'colleague@corp.example', refs: '<r1> <r3>' },
      // Headers pointing outside the thread still count as header threading: stays.
      { mid: '<h5>', thread: '<r1>', subject: 'Weekly report', from: 'boss@corp.example', inReplyTo: '<gone>' },
    ]);

    await migrate();

    expect(await threads()).toEqual({
      '<r1>': '<r1>', '<h1>': '<r1>', '<h4>': '<r1>', '<h5>': '<r1>',
      '<r2>': '<r2>', '<h2>': '<r2>', '<h3>': '<r2>',
      '<r3>': '<r3>',
    });
  });

  it('moves bulk members whatever their subject, and never counts them as an exchange', async () => {
    await insert([
      { mid: '<b1>', thread: '<b1>', subject: 'Lunch', from: 'anna@partner.com' },
      // Bulk, so it moves even with a prefix.
      { mid: '<b2>', thread: '<b1>', subject: 'Re: Lunch', from: 'carol@list.example', to: [{ email: 'dave@partner.com' }], bulk: true },
      // Its only exchange is with the bulk message, which keeps nothing in place.
      { mid: '<b3>', thread: '<b1>', subject: 'Lunch', from: 'dave@partner.com' },
      // A bulk root does not hold an exchange together either.
      { mid: '<n1>', thread: '<n1>', subject: 'Offer', from: 'deals@shop.example', to: [{ email: 'erin@partner.com' }], bulk: true },
      { mid: '<n2>', thread: '<n1>', subject: 'Offer', from: 'erin@partner.com' },
    ]);

    await migrate();

    expect(await threads()).toEqual({
      '<b1>': '<b1>', '<b2>': '<b2>', '<b3>': '<b3>', '<n1>': '<n1>', '<n2>': '<n2>',
    });
  });

  it('follows the reference computeThreadId would pick when the first one is missing', async () => {
    await insert([
      { mid: '<z1>', thread: '<z1>', subject: 'Budget', from: 'boss@corp.example' },
      { mid: '<z2>', thread: '<z1>', subject: 'Budget', from: 'boss@corp.example' },
      // <gone> is not in the account, so the reply was threaded through <z2>, the last
      // candidate that exists, and leaves with it.
      { mid: '<z3>', thread: '<z1>', subject: 'Re: Budget', from: 'colleague@corp.example', inReplyTo: '<z2>', refs: '<gone> <z2>' },
      // The first reference exists, so that one wins even though a later one leaves.
      { mid: '<z4>', thread: '<z1>', subject: 'Re: Budget', from: 'colleague@corp.example', inReplyTo: '<z2>', refs: '<z1> <z2>' },
      // Nothing it names exists: it keeps its thread.
      { mid: '<z5>', thread: '<z1>', subject: 'Re: Budget', from: 'colleague@corp.example', inReplyTo: '<lost>', refs: '<gone>' },
    ]);

    await migrate();

    expect(await threads()).toEqual({
      '<z1>': '<z1>', '<z4>': '<z1>', '<z5>': '<z1>', '<z2>': '<z2>', '<z3>': '<z2>',
    });
  });

  it('keeps a header-less reply sent to a bulk sender with what it answers', async () => {
    await insert([
      { mid: '<t1>', thread: '<t1>', subject: 'Survey', from: 'team@vendor.example', bulk: true },
      // Our Sent copy, headers dropped: addressed to the survey's sender, so it stays.
      { mid: '<t2>', thread: '<t1>', subject: 'RE: Survey', from: OWNER, to: [{ email: 'team@vendor.example' }] },
      // Without a prefix too: it is still addressed to that sender.
      { mid: '<t3>', thread: '<t1>', subject: 'Survey', from: OWNER, to: [{ email: 'team@vendor.example' }] },
      // The other direction does not count: the survey was not an answer to Frank.
      { mid: '<l1>', thread: '<l1>', subject: 'Meetup', from: 'list@lists.example', to: [{ email: 'frank@partner.com' }], bulk: true },
      { mid: '<l2>', thread: '<l1>', subject: 'Meetup', from: 'frank@partner.com' },
    ]);

    await migrate();

    expect(await threads()).toEqual({
      '<t1>': '<t1>', '<t2>': '<t1>', '<t3>': '<t1>', '<l1>': '<l1>', '<l2>': '<l2>',
    });
  });

  it('does not let two suspects keep each other in', async () => {
    await insert([
      { mid: '<p1>', thread: '<p1>', subject: 'Planning', from: 'xavier@else.example' },
      // Anna and Bob wrote to each other, but neither has anything to do with the root.
      { mid: '<p2>', thread: '<p1>', subject: 'Planning', from: 'anna@partner.com', to: [{ email: 'bob@partner.com' }] },
      { mid: '<p3>', thread: '<p1>', subject: 'Planning', from: 'bob@partner.com', to: [{ email: 'anna@partner.com' }] },
      // Carol answers the root, and Dave answers Carol: a chain grown from the root stays.
      { mid: '<p4>', thread: '<p1>', subject: 'Planning', from: 'carol@partner.com', to: [{ email: 'xavier@else.example' }] },
      { mid: '<p5>', thread: '<p1>', subject: 'Planning', from: 'dave@partner.com', to: [{ email: 'carol@partner.com' }] },
    ]);

    await migrate();

    expect(await threads()).toEqual({
      '<p1>': '<p1>', '<p2>': '<p2>', '<p3>': '<p3>', '<p4>': '<p1>', '<p5>': '<p1>',
    });
  });

  it('splits a real exchange whose root was expunged, as documented', async () => {
    // My "Keys" to Anna is gone; her two answers have no prefix and no headers, and share no
    // correspondent with each other. Threading them afresh would keep them with the root.
    await insert([
      { mid: '<k1>', thread: '<k1>', subject: 'Keys', from: OWNER, to: [{ email: 'anna@partner.com' }], deleted: true },
      { mid: '<k2>', thread: '<k1>', subject: 'Keys', from: 'anna@partner.com' },
      { mid: '<k3>', thread: '<k1>', subject: 'Keys', from: 'anna@partner.com' },
    ]);

    await migrate();

    expect(await threads()).toEqual({ '<k1> deleted': '<k1>', '<k2>': '<k2>', '<k3>': '<k3>' });
  });

  it('treats an alias as the account itself, not as a correspondent', async () => {
    await insert([
      // Sent from the shared support@ alias to a customer.
      { mid: '<a1>', thread: '<a1>', subject: 'Ticket received', from: 'support@example.com', to: [{ email: 'customer@else.example' }] },
      // An unrelated notice addressed to support@. Were the alias a correspondent, the first
      // message's sender would be among this one's recipients and pass for an exchange.
      { mid: '<a2>', thread: '<a1>', subject: 'Ticket received', from: 'alerts@tracker.example', to: [{ email: 'support@example.com' }] },
    ]);

    await migrate();

    expect(await threads()).toEqual({ '<a1>': '<a1>', '<a2>': '<a2>' });
  });

  it('leaves correct data alone and changes nothing on a second run', async () => {
    await insert([
      { mid: '<x1>', thread: '<x1>', subject: 'Hello', from: 'anna@partner.com' },
      { mid: '<x2>', thread: '<x1>', subject: 'Re: Hello', from: OWNER, inReplyTo: '<x1>', refs: '<x1>' },
      { mid: '<y1>', thread: '<y1>', subject: 'Hello', from: 'anna@partner.com' },
      { mid: '<z1>', thread: null, subject: 'No id', from: 'anna@partner.com' },
      { mid: '<d1>', thread: '<d1>', subject: 'Receipt', from: 'orders@shop.example' },
      { mid: '<d2>', thread: '<d1>', subject: 'Receipt', from: 'orders@shop.example' },
      { mid: '<b1>', thread: '<b1>', subject: 'Lunch', from: 'anna@partner.com' },
      { mid: '<b2>', thread: '<b1>', subject: 'Re: Lunch', from: 'carol@list.example', to: [{ email: 'dave@partner.com' }], bulk: true },
      { mid: '<b3>', thread: '<b1>', subject: 'Lunch', from: 'dave@partner.com' },
      { mid: '<w1>', thread: '<w1>', subject: 'Weekly report', from: 'boss@corp.example' },
      { mid: '<wh1>', thread: '<w1>', subject: 'Re: Weekly report', from: 'colleague@corp.example', refs: '<w1>' },
      { mid: '<w2>', thread: '<w1>', subject: 'Weekly report', from: 'boss@corp.example' },
      { mid: '<wh2>', thread: '<w1>', subject: 'Re: Weekly report', from: 'colleague@corp.example', refs: '<w2>' },
    ]);

    await migrate();
    const once = await threads();
    expect(once).toMatchObject({ '<x1>': '<x1>', '<x2>': '<x1>', '<y1>': '<y1>', '<z1>': null, '<d2>': '<d2>', '<b3>': '<b3>',
      '<w1>': '<w1>', '<wh1>': '<w1>', '<w2>': '<w2>', '<wh2>': '<w2>' });

    await migrate();
    expect(await threads()).toEqual(once);
  });
});
