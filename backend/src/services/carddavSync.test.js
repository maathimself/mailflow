import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: () => 'app-password' }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: false }) }));
vi.mock('./carddavClient.js', () => ({ discoverAddressBooks: vi.fn(), fetchAddressBookCards: vi.fn() }));

import { query } from './db.js';
import { discoverAddressBooks, fetchAddressBookCards } from './carddavClient.js';
import { generateVCard, parseVCard } from '../utils/vcard.js';
import { syncUser } from './carddavSync.js';

// Alice as the user entered her in their Personal book.
const alice = {
  uid: 'local-uid', displayName: 'Alice', firstName: 'Alice', lastName: 'Smith',
  emails: [{ value: 'alice@example.com', type: 'other', primary: true }],
  phones: [{ value: '+1 555 0100', type: 'cell' }],
  organization: 'Acme', notes: 'met at conf 2025',
};

// Postgres hands JSONB objects back with their keys in its own order, not as written.
const pgPhones = phones => phones.map(({ value, type }) => ({ type, value }));

// A contact's row in the user's Personal book.
function personalRow(contact = alice, vcard = generateVCard(contact)) {
  return {
    address_book_id: 'personal-book', uid: contact.uid, vcard, etag: 'e1',
    primary_email: contact.emails[0].value,
    display_name: contact.displayName, first_name: contact.firstName, last_name: contact.lastName,
    emails: contact.emails, phones: pgPhones(contact.phones),
    organization: contact.organization, notes: contact.notes, photo_data: null,
  };
}

// The same Alice as a phone stored her through MailFlow's CardDAV server, with
// properties MailFlow does not model.
const phoneCard = [
  'BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN', 'UID:local-uid',
  'N:Smith;Alice;;;', 'FN:Alice', 'ORG:Acme', 'EMAIL;TYPE=HOME:alice@example.com',
  'TEL;TYPE=CELL:+1 555 0100', 'NOTE:met at conf 2025', 'BDAY:1990-04-01',
  'ADR;TYPE=HOME:;;1 Main St;Springfield;;12345;USA', 'END:VCARD', '',
].join('\r\n');

// Alice's card on the remote server, which merge mode matches to her by email.
const remoteCard = (...lines) =>
  ['BEGIN:VCARD', 'VERSION:3.0', 'UID:nc-alice', ...lines, 'EMAIL:alice@example.com', 'END:VCARD', ''].join('\r\n');

const photoLine = 'PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgo=';
const photoUri = 'data:image/png;base64,iVBORw0KGgo=';

// The remote server's address books, each mirrored into a read-only local book.
const contactsBook = { url: 'https://dav.example.com/alice/contacts/', displayName: 'Contacts' };
const teamBook = { url: 'https://dav.example.com/alice/team/', displayName: 'Team' };
const mirrorOf = { [contactsBook.url]: 'remote-book', [teamBook.url]: 'team-book' };

// The contacts in the user's own address books, by id.
let rows;

beforeEach(() => {
  rows = { alice: personalRow() };
  discoverAddressBooks.mockResolvedValue([contactsBook]);
  query.mockReset();
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM user_integrations')) {
      return { rows: [{ config: { serverUrl: 'https://dav.example.com', username: 'alice', password: 'x', dupMode: 'merge' } }] };
    }
    if (sql.includes('external_url = $2')) return { rows: [{ id: mirrorOf[params[1]] }] };
    if (sql.includes('SELECT id, primary_email FROM contacts')) {
      const listed = Object.entries(rows).filter(([, r]) => r.address_book_id !== params[1] && r.primary_email);
      return { rows: listed.map(([id, r]) => ({ id, primary_email: r.primary_email })) };
    }
    if (/FROM contacts\s+WHERE id = \$1/.test(sql)) {
      const r = rows[params[0]];
      if (!r) return { rows: [] };
      // Only the columns the SELECT names, as PostgreSQL returns them.
      const columns = sql.match(/SELECT([\s\S]+?)FROM/)[1].split(',').map(col => col.trim());
      return { rows: [Object.fromEntries(columns.map(col => [col, r[col]]))] };
    }
    if (/^\s*UPDATE contacts/.test(sql)) {
      const [id, display_name, first_name, last_name, phones, organization, notes, photo, vcard, etag] = params;
      // The statement's etag condition, if it has one, as PostgreSQL applies it.
      const etagParam = sql.match(/AND etag = \$(\d+)/)?.[1];
      const r = rows[id];
      if (!r || (etagParam && r.etag !== params[Number(etagParam) - 1])) return { rows: [], rowCount: 0 };
      rows[id] = {
        ...r, display_name, first_name, last_name, phones: pgPhones(JSON.parse(phones)),
        organization, notes, photo_data: photo ?? r.photo_data, vcard, etag,
      };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
});

async function syncCard(vcard) {
  fetchAddressBookCards.mockResolvedValue([{ href: '/alice/contacts/alice.vcf', vcard }]);
  expect(await syncUser('u1')).toMatchObject({ ok: true });
}

// One card in the Contacts book and one in the Team book, in that order. Alice's card in
// the Team book has a UID of its own.
function serveBothBooks(contactsCard, teamCard) {
  discoverAddressBooks.mockResolvedValue([contactsBook, teamBook]);
  const cards = { [contactsBook.url]: contactsCard, [teamBook.url]: teamCard.replace('UID:nc-alice', 'UID:team-alice') };
  fetchAddressBookCards.mockImplementation(async ({ url }) => [{ href: `${url}card.vcf`, vcard: cards[url] }]);
}

// Makes the user's change once, as soon as the sync has run a query that `step` matches.
function editDuringSync(step, edit) {
  const db = query.getMockImplementation();
  let done = false;
  query.mockImplementation(async (sql, params) => {
    const result = await db(sql, params);
    if (!done && step.test(sql)) {
      done = true;
      edit();
    }
    return result;
  });
}
const listing = /SELECT id, primary_email FROM contacts/;
const contactRead = /FROM contacts\s+WHERE id = \$1/;

const contactWrites = () => query.mock.calls.filter(([sql]) => /^\s*UPDATE contacts/.test(sql));
const bumpedBooks = () => query.mock.calls
  .filter(([sql]) => sql.includes('UPDATE address_books SET sync_token'))
  .map(([, params]) => params[0]);

// The SQL, columns and stored vCard of the one write to Alice's contact.
function written() {
  const writes = contactWrites();
  expect(writes).toHaveLength(1);
  const [sql, [id, display_name, first_name, last_name, phones, organization, notes, photo, vcard, etag]] = writes[0];
  expect(id).toBe('alice');
  return {
    sql, display_name, first_name, last_name, phones: JSON.parse(phones), organization, notes, photo,
    vcard, etag, card: parseVCard(vcard),
  };
}

describe('syncUser in merge mode', () => {
  it("keeps the contact's own details that the card does not carry", async () => {
    rows.alice.photo_data = 'data:image/jpeg;base64,/9j/4AAQ';
    rows.alice.emails = [...alice.emails, { value: 'alice@work.example', type: 'work', primary: false }];
    await syncCard(remoteCard('FN:Alice Smith'));

    const w = written();
    expect(w).toMatchObject({
      display_name: 'Alice Smith', first_name: 'Alice', last_name: 'Smith',
      phones: [{ value: '+1 555 0100', type: 'cell' }], organization: 'Acme', notes: 'met at conf 2025',
    });
    expect(w.photo).toBeNull();
    expect(w.sql).toContain('photo_data = COALESCE($8, photo_data)');
    expect(w.card).toMatchObject({
      uid: 'local-uid', displayName: 'Alice Smith', lastName: 'Smith',
      phones: [{ value: '+1 555 0100', type: 'cell' }], organization: 'Acme', notes: 'met at conf 2025',
    });
    expect(w.card.emails.map(e => e.value)).toEqual(['alice@example.com', 'alice@work.example']);
    expect(w.etag).toBe(crypto.createHash('md5').update(w.vcard).digest('hex'));
  });

  it("lets the card win where it has a value and adds its numbers after the contact's own", async () => {
    rows.alice.photo_data = 'data:image/jpeg;base64,/9j/4AAQ';
    await syncCard(remoteCard(
      'FN:Alicia Jones', 'N:Jones;Alicia;;;', 'TEL;TYPE=WORK:+1 555 0199', 'TEL;TYPE=HOME:+1 555 0100',
      'ORG:NewCo', 'NOTE:from Nextcloud', photoLine,
    ));

    expect(written()).toMatchObject({
      display_name: 'Alicia Jones', first_name: 'Alicia', last_name: 'Jones',
      phones: [{ value: '+1 555 0100', type: 'home' }, { value: '+1 555 0199', type: 'work' }],
      organization: 'NewCo', notes: 'from Nextcloud', photo: photoUri,
    });
  });

  it("keeps the contact's type for a number the card lists without one", async () => {
    await syncCard(remoteCard('FN:Alice', 'TEL:+1 555 0100', 'TEL:+1 555 0199'));

    expect(written().phones).toEqual([{ value: '+1 555 0100', type: 'cell' }, { value: '+1 555 0199', type: 'other' }]);
  });

  it('matches a number the contact has with a trailing space', async () => {
    const phones = [{ value: '+1 555 0100 ', type: 'cell' }, { value: '+1 555 0142', type: 'home' }];
    rows.alice = personalRow({ ...alice, phones });
    await syncCard(remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100'));

    expect(written().phones).toEqual([{ value: '+1 555 0100', type: 'cell' }, { value: '+1 555 0142', type: 'home' }]);
  });

  it.each([
    ['does not have', alice.phones],
    ['has once', [...alice.phones, { value: '+1 555 0199', type: 'home' }]],
  ])('keeps both types of a number the card lists twice and the contact %s, and settles', async (_, phones) => {
    rows.alice = personalRow({ ...alice, phones });
    const card = remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0199', 'TEL;TYPE=WORK:+1 555 0199');
    await syncCard(card);
    expect(written().phones).toEqual([
      { value: '+1 555 0100', type: 'cell' }, { value: '+1 555 0199', type: 'cell' }, { value: '+1 555 0199', type: 'work' },
    ]);

    query.mockClear();
    await syncCard(card);
    expect(contactWrites()).toEqual([]);
  });

  it.each([
    ['has no FN', remoteCard('NOTE:from Nextcloud')],
    ['has the email address as its FN', remoteCard('FN:Alice@Example.com', 'NOTE:from Nextcloud')],
  ])('does not rename the contact to its email when the card %s', async (_, vcard) => {
    await syncCard(vcard);

    const w = written();
    expect(w.display_name).toBe('Alice');
    expect(w.card.displayName).toBe('Alice');
  });

  it('keeps the name of a contact named after its email when the card has no name either', async () => {
    rows.alice = personalRow({ ...alice, displayName: 'alice@example.com' });
    await syncCard(remoteCard('NOTE:from Nextcloud'));

    expect(written().display_name).toBe('alice@example.com');
  });

  it('does not name a contact after its email from a later book either', async () => {
    rows.alice.display_name = null;
    serveBothBooks(remoteCard('NOTE:from A'), remoteCard('NOTE:from B'));

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(rows.alice.display_name).toBeNull();
  });

  it('names a contact named after its email from a later book when the first has no name, and settles', async () => {
    rows.alice = personalRow({ ...alice, displayName: 'alice@example.com', firstName: null, lastName: null });
    serveBothBooks(remoteCard('FN:alice@example.com', 'NOTE:from A'), remoteCard('FN:Alice Smith', 'N:Smith;Alice;;;'));

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(rows.alice).toMatchObject({ display_name: 'Alice Smith', first_name: 'Alice', last_name: 'Smith', notes: 'from A' });

    query.mockClear();
    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(contactWrites()).toEqual([]);
  });

  it("stores the card's FN for a contact that has no display name", async () => {
    rows.alice.display_name = null;
    await syncCard(remoteCard('FN:Alice Smith'));

    expect(written()).toMatchObject({ display_name: 'Alice Smith', notes: 'met at conf 2025' });
  });

  it("bumps the merged contact's book so CardDAV clients fetch the change", async () => {
    await syncCard(remoteCard('FN:Alice Smith'));

    expect(bumpedBooks().sort()).toEqual(['personal-book', 'remote-book']);
  });

  it.each([
    ['as MailFlow generated it', generateVCard(alice)],
    ['as a phone stored it', phoneCard],
    ['as a phone stored it under a UID other than its file name', phoneCard.replace('UID:local-uid', 'UID:5F2C9E1A:ABPerson')],
    ['under a UID the remote card has too', generateVCard({ ...alice, uid: 'nc-alice' }), 'nc-alice'],
  ])('writes nothing when the merge changes nothing (card %s)', async (_, vcard, uid = alice.uid) => {
    rows.alice = { ...personalRow(alice, vcard), uid };
    await syncCard(remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100'));

    expect(contactWrites()).toEqual([]);
    expect(bumpedBooks()).toEqual(['remote-book']);
  });

  it('writes nothing when the card lists the same numbers in another order', async () => {
    const phones = [{ value: '+1 555 0100', type: 'cell' }, { value: '+1 555 0199', type: 'work' }];
    rows.alice = personalRow({ ...alice, phones });
    await syncCard(remoteCard('FN:Alice', 'TEL;TYPE=WORK:+1 555 0199', 'TEL;TYPE=CELL:+1 555 0100'));

    expect(contactWrites()).toEqual([]);
  });

  it.each([
    ['the remote card, as an earlier merge stored it', remoteCard('FN:Alice', 'N:Smith;Alice;;;', 'TEL;TYPE=CELL:+1 555 0100', 'ORG:Acme', 'NOTE:met at conf 2025')],
    ['missing', null],
  ])("stores the contact's own card when its stored card is %s", async (_, vcard) => {
    rows.alice = personalRow(alice, vcard);
    await syncCard(remoteCard('FN:Alice', 'N:Smith;Alice;;;', 'TEL;TYPE=CELL:+1 555 0100', 'ORG:Acme', 'NOTE:met at conf 2025'));

    expect(written().card).toMatchObject({ uid: 'local-uid', displayName: 'Alice', notes: 'met at conf 2025' });
  });

  it('leaves a contact edited during the sync for the next sync', async () => {
    editDuringSync(contactRead, () => {
      rows.alice = { ...rows.alice, notes: 'edited', etag: 'e2' };
    });
    await syncCard(remoteCard('FN:Alice Smith'));

    expect(rows.alice).toMatchObject({ display_name: 'Alice', notes: 'edited', etag: 'e2' });
    expect(bumpedBooks()).toEqual(['remote-book']);
  });

  it.each([
    ['deleted', () => { delete rows.alice; }],
    ['given another address', () => { rows.alice = { ...rows.alice, primary_email: 'alicia@other.example', etag: 'e2' }; }],
  ])('skips a contact %s after the sync listed it', async (_, edit) => {
    editDuringSync(listing, edit);
    await syncCard(remoteCard('FN:Alice Smith'));

    expect(contactWrites()).toEqual([]);
    expect(bumpedBooks()).toEqual(['remote-book']);
  });

  it("takes the card's photo when that is all it adds, once", async () => {
    const card = remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100', photoLine);
    await syncCard(card);

    expect(written().photo).toBe(photoUri);
    expect(bumpedBooks().sort()).toEqual(['personal-book', 'remote-book']);

    query.mockClear();
    await syncCard(card);
    expect(contactWrites()).toEqual([]);
  });

  it('settles when two remote books have a card for the same email', async () => {
    serveBothBooks(
      remoteCard('FN:Alice A', 'N:Ayala;Alicia;;;', 'ORG:A Corp', 'NOTE:from A', 'TEL;TYPE=WORK:+1 555 0199', photoLine),
      remoteCard(
        'FN:Alice B', 'N:Brown;Alba;;;', 'ORG:B Corp', 'NOTE:from B',
        'TEL;TYPE=CELL:+1 555 0199', 'TEL;TYPE=HOME:+1 555 0142', 'PHOTO;ENCODING=b;TYPE=GIF:R0lGODlh',
      ),
    );

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    // The first book wins where both have a value; the second only fills gaps.
    expect(rows.alice).toMatchObject({
      display_name: 'Alice A', first_name: 'Alicia', last_name: 'Ayala', organization: 'A Corp', notes: 'from A',
      photo_data: photoUri,
      phones: [
        { type: 'cell', value: '+1 555 0100' }, { type: 'work', value: '+1 555 0199' },
        { type: 'home', value: '+1 555 0142' },
      ],
    });

    query.mockClear();
    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(contactWrites()).toEqual([]);
    expect(bumpedBooks().sort()).toEqual(['remote-book', 'team-book']);
  });

  it("fills the contact's gaps from a later book, and bumps its book when only that changed it", async () => {
    rows.alice.organization = null;
    serveBothBooks(remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100'), remoteCard('FN:Alice B', 'ORG:B Corp', photoLine));

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(rows.alice).toMatchObject({ display_name: 'Alice', organization: 'B Corp', photo_data: photoUri });
    expect(bumpedBooks().sort()).toEqual(['personal-book', 'remote-book', 'team-book']);
  });

  it("does not add a later book's number that the contact has with a trailing space", async () => {
    rows.alice = personalRow({ ...alice, phones: [{ value: '+1 555 0100 ', type: 'cell' }] });
    serveBothBooks(remoteCard('FN:Alice'), remoteCard('FN:Alice', 'TEL;TYPE=CELL:+1 555 0100'));

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(contactWrites()).toEqual([]);
  });

  it('lets the card win for a contact that only a later book matches', async () => {
    rows.bob = personalRow({
      uid: 'bob-uid', displayName: 'Bob', firstName: 'Bob', lastName: 'Jones',
      emails: [{ value: 'bob@example.com', type: 'other', primary: true }], phones: [],
      organization: 'Old Co', notes: null,
    });
    const bobCard = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:team-bob', 'FN:Robert', 'ORG:Team Co', 'EMAIL:bob@example.com', 'END:VCARD', ''];
    serveBothBooks(remoteCard('FN:Alice A'), bobCard.join('\r\n'));

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(rows.alice.display_name).toBe('Alice A');
    expect(rows.bob).toMatchObject({ display_name: 'Robert', organization: 'Team Co' });
  });

  it("replaces a later book's card that the old merge stored, when the first book changes nothing", async () => {
    const teamCard = remoteCard('FN:Alice', 'N:Smith;Alice;;;', 'TEL;TYPE=CELL:+1 555 0100', 'ORG:Acme', 'NOTE:met at conf 2025');
    rows.alice = personalRow(alice, teamCard.replace('UID:nc-alice', 'UID:team-alice'));
    serveBothBooks(remoteCard('FN:Alice'), teamCard);

    expect(await syncUser('u1')).toMatchObject({ ok: true });
    expect(parseVCard(rows.alice.vcard).uid).toBe('local-uid');
    expect(bumpedBooks().sort()).toEqual(['personal-book', 'remote-book', 'team-book']);
  });
});
