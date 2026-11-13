import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { fillVariables, fillSubject, fillNames, fillNameHtml, needsContact, findRecipientContact } = await import('./variables.js');
after(() => dom.window.close());

test('deferred filling changes only remaining name tokens, keeping dates and custom text intact', () => {
  const contact = { first_name: 'Bob & <Jones>' };
  assert.equal(fillNames('My greeting {{ contact.givenName }} {{ date.month }} {{ add placeholder }}', contact), 'My greeting Bob & <Jones> {{ date.month }} {{ add placeholder }}');
  const html = fillNameHtml('<p><strong>My greeting</strong> {{ contact.givenName }} {{ contact.surname }}</p>', contact);
  assert.match(html, /<strong>My greeting<\/strong> Bob &amp; &lt;Jones&gt; \{\{ contact.surname \}\}/);
  const unchanged = '<p title="{{ contact.givenName }}">My edited name</p>';
  assert.equal(fillNameHtml(unchanged, contact), unchanged);
  assert.equal(needsContact('contact.givenName'), false);
  assert.equal(needsContact('{{ contact.givenName }}'), true);
});

test('subject variables remain plain text and cannot introduce header line breaks', () => {
  assert.equal(fillSubject('Hello {{ contact.fullName }}', { contact: { display_name: 'A & <B>\r\nCc: x' } }), 'Hello A & <B> Cc: x');
  assert.equal(fillSubject('Hello {{ contact.givenName }}'), 'Hello {{ contact.givenName }}');
});

test('date tokens use the insertion date and selected locale', () => {
  const now = new Date('2026-11-10T14:30:00Z');
  const html = fillVariables('<p>{{ date.date }}|{{ date.longDate }}|{{ date.dateTime }}|{{ date.month }}</p>', { now, locale: 'en-CA' });
  for (const options of [{ dateStyle: 'short' }, { dateStyle: 'long' }, { dateStyle: 'short', timeStyle: 'short' }, { month: 'long' }]) {
    assert.ok(html.includes(new Intl.DateTimeFormat('en-CA', options).format(now)));
  }
  assert.doesNotMatch(html, /\{\{/);
});

test('contact names are literal text, unknown and missing values stay visible', () => {
  const html = fillVariables('<p>{{ contact.fullName }}|{{ contact.givenName }}|{{ contact.surname }}|{{ add placeholder }}|{{ unknown }}</p>', {
    contact: { display_name: '<img src=x onerror=alert(1)> & Smith', first_name: 'Alice' },
  });
  const container = document.createElement('div'); container.innerHTML = html;
  assert.equal(container.querySelector('img'), null);
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)> & Smith\|Alice\|\{\{ contact.surname \}\}/);
  assert.match(html, /\{\{ add placeholder \}\}/);
  assert.match(html, /\{\{ unknown \}\}/);
  assert.match(fillVariables('{{ contact.fullName }}'), /\{\{ contact.fullName \}\}/);
});

test('tokens never replace attributes or recursively expand values', () => {
  const html = fillVariables('<a href="https://example.com/{{ contact.fullName }}">{{ contact.fullName }}</a><script>alert(1)</script>', {
    contact: { display_name: '{{ date.month }}' },
  });
  assert.match(html, /href="https:\/\/example.com\/\{\{ contact.fullName \}\}"/);
  assert.match(html, />\{\{ date.month \}\}<\/a>/);
  assert.doesNotMatch(html, /script/);
});

test('recipient lookup matches exact emails including secondary addresses, preferring saved contacts', async () => {
  const saved = { display_name: 'Saved', emails: [{ value: 'BOB@example.com' }] };
  const contact = await findRecipientContact({ getContacts: async args => {
    assert.equal(args.q, 'bob@example.com');
    return { contacts: [{ primary_email: 'notbob@example.com', display_name: 'Wrong' }, { primary_email: 'bob@example.com', is_auto: true }, saved] };
  } }, 'Bob <bob@example.com>');
  assert.equal(contact, saved);
  assert.equal(await findRecipientContact({ getContacts: async () => ({ contacts: [{ primary_email: 'notbob@example.com' }] }) }, 'bob@example.com'), null);
  assert.equal(await findRecipientContact({ getContacts: () => assert.fail('no lookup for an empty recipient') }, ''), null);
});
