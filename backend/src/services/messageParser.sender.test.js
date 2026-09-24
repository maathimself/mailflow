import { describe, it, expect } from 'vitest';
import {
  parseMessage,
  detectAliasForwarder,
  detectCategoryFromHeaders,
  detectBulkFromParsedHeaders,
  unwrapForwarderHeaders,
  ALIAS_FORWARDER_HEADERS,
} from './messageParser.js';

// The RFC 5322 Sender / IMAP ENVELOPE sender (#366) is surfaced as "via X" only when it names a
// DIFFERENT mailbox than From. Servers default ENVELOPE sender to From when the Sender header is
// absent, so parseMessage must return null unless the sender address genuinely differs — otherwise
// every ordinary message would show a spurious "via".
const msg = (envelope) => ({ uid: 1, envelope, flags: [] });

describe('parseMessage — sender ("via") extraction', () => {
  it('surfaces a distinct Sender (on-behalf-of / via)', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Boss', address: 'boss@corp.com' }],
      sender: [{ name: 'Mailing Service', address: 'bounce@service.io' }],
    }));
    expect(p.senderEmail).toBe('bounce@service.io');
    expect(p.senderName).toBe('Mailing Service');
  });

  it('returns null when there is no Sender', async () => {
    const p = await parseMessage(msg({ from: [{ name: 'Alice', address: 'alice@example.com' }] }));
    expect(p.senderEmail).toBeNull();
    expect(p.senderName).toBeNull();
  });

  it('returns null when Sender equals From (server-defaulted, not a real via)', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      sender: [{ name: 'Alice', address: 'alice@example.com' }],
    }));
    expect(p.senderEmail).toBeNull();
    expect(p.senderName).toBeNull();
  });

  it('compares the Sender address case-insensitively', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Alice', address: 'Alice@Example.com' }],
      sender: [{ name: 'Alice', address: 'alice@example.com' }],
    }));
    expect(p.senderEmail).toBeNull();
  });

  it('keeps a distinct Sender that has no display name', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Boss', address: 'boss@corp.com' }],
      sender: [{ address: 'svc@platform.com' }],
    }));
    expect(p.senderEmail).toBe('svc@platform.com');
    expect(p.senderName).toBe('');
  });

  it('supports the legacy mailbox/host address shape', async () => {
    const p = await parseMessage(msg({
      from: [{ name: 'Boss', mailbox: 'boss', host: 'corp.com' }],
      sender: [{ name: 'Svc', mailbox: 'svc', host: 'platform.com' }],
    }));
    expect(p.senderEmail).toBe('svc@platform.com');
    expect(p.senderName).toBe('Svc');
  });
});

// Alias-forwarding services (#475). Header shapes are taken from real 33Mail-wrapped mail with
// every address replaced: 33Mail puts its own address in From, carries the original sender only
// in the display name, sets Sender = From, adds X-33Mail-Original-To (the receiving alias) and
// replaces the original List-Unsubscribe with its own on every message.
const WRAPPER = 'sender@mailer1.33mail.com';
const wrappedHeaders = (extra = '') => [
  `From: "Stripe 'billing@stripe.example' via 33Mail"\r\n <${WRAPPER}>`,
  `Sender: 33Mail <${WRAPPER}>`,
  'To: me@gmail.example',
  'Delivered-To: me@gmail.example',
  'X-33Mail-Original-To: shop@myname.33mail.com',
  'List-Unsubscribe: <mailto:unsubscribe-abc123@unsub.33mail.com>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  extra,
].filter(Boolean).join('\r\n') + '\r\n';

const wrappedMsg = ({ name = "Stripe 'billing@stripe.example' via 33Mail", headers = wrappedHeaders() } = {}) => ({
  uid: 1,
  flags: [],
  envelope: {
    from: [{ name, address: WRAPPER }],
    sender: [{ name: '33Mail', address: WRAPPER }],
    to: [{ name: '', address: 'me@gmail.example' }],
  },
  headers,
});

describe('parseMessage — alias-forwarding services (#475)', () => {
  it('derives the original sender of a 33Mail wrapper into separate fields', async () => {
    const p = await parseMessage(wrappedMsg());
    expect(p.forwardedFromName).toBe('Stripe');
    expect(p.forwardedFromEmail).toBe('billing@stripe.example');
    expect(p.forwardedVia).toBe('33Mail');
  });

  it('never replaces From with the derived sender', async () => {
    const p = await parseMessage(wrappedMsg());
    expect(p.fromEmail).toBe(WRAPPER);
    expect(p.fromName).toBe("Stripe 'billing@stripe.example' via 33Mail");
  });

  it('does not trigger the #366 "via" path (33Mail sets Sender = From)', async () => {
    const p = await parseMessage(wrappedMsg());
    expect(p.senderEmail).toBeNull();
  });

  it('adds the receiving alias to deliveryAddresses', async () => {
    const p = await parseMessage(wrappedMsg());
    expect(p.deliveryAddresses).toEqual(['me@gmail.example', 'shop@myname.33mail.com']);
  });

  it('handles a wrapper without a display name for the original sender', async () => {
    const p = await parseMessage(wrappedMsg({ name: "'noreply@shop.example' via 33Mail" }));
    expect(p.forwardedFromName).toBe('');
    expect(p.forwardedFromEmail).toBe('noreply@shop.example');
  });

  it('accepts typographic quotes around the original address', async () => {
    const p = await parseMessage(wrappedMsg({ name: 'Shop \u2018orders@shop.example\u2019 via 33Mail' }));
    expect(p.forwardedFromEmail).toBe('orders@shop.example');
  });

  it('leaves the fields null for ordinary mail', async () => {
    const p = await parseMessage(msg({ from: [{ name: 'Alice', address: 'alice@example.com' }] }));
    expect(p.forwardedFromEmail).toBeNull();
    expect(p.forwardedFromName).toBeNull();
    expect(p.forwardedVia).toBeNull();
  });
});

describe('detectAliasForwarder — spoofing resistance (#475)', () => {
  it('does NOT unwrap a normal message whose display name imitates the pattern', async () => {
    const p = await parseMessage({
      uid: 1,
      flags: [],
      envelope: { from: [{ name: "PayPal 'service@paypal.com' via 33Mail", address: 'attacker@evil.example' }] },
      headers: `From: "PayPal 'service@paypal.com' via 33Mail" <attacker@evil.example>\r\n`,
    });
    expect(p.forwardedFromEmail).toBeNull();
    expect(p.fromEmail).toBe('attacker@evil.example');
  });

  it('does NOT unwrap when the service header is forged on a non-33Mail From', async () => {
    const p = await parseMessage({
      uid: 1,
      flags: [],
      envelope: { from: [{ name: "PayPal 'service@paypal.com' via 33Mail", address: 'attacker@evil.example' }] },
      headers: [
        `From: "PayPal 'service@paypal.com' via 33Mail" <attacker@evil.example>`,
        'X-33Mail-Original-To: shop@myname.33mail.com',
      ].join('\r\n') + '\r\n',
    });
    expect(p.forwardedFromEmail).toBeNull();
    expect(p.deliveryAddresses).toEqual([]);
  });

  it('rejects look-alike domains', () => {
    for (const fromEmail of ['sender@mailer1.33mail.com.evil.example', 'sender@evil33mail.com', 'sender@33mail.co']) {
      expect(detectAliasForwarder({
        fromEmail,
        fromName: "PayPal 'service@paypal.com' via 33Mail",
        headers: { 'x-33mail-original-to': 'shop@myname.33mail.com' },
      })).toBeNull();
    }
  });

  it('leaves mail sent by the service itself alone (no alias header, no wrapper name)', () => {
    expect(detectAliasForwarder({ fromEmail: 'support@33mail.com', fromName: '33Mail', headers: {} })).toBeNull();
  });

  it('ignores a wrapper name whose "address" is not an address', () => {
    expect(detectAliasForwarder({
      fromEmail: WRAPPER, fromName: "Stripe 'not an address' via 33Mail", headers: {},
    })).toBeNull();
  });

  it('bails out on oversized display names without scanning them', () => {
    const name = `${'x'.repeat(5000)} 'a@b.example' via 33Mail`;
    expect(detectAliasForwarder({ fromEmail: WRAPPER, fromName: name, headers: {} })).toBeNull();
  });
});

describe('header classification — alias-forwarding services (#475)', () => {
  // Header maps as parseHeadersInput produces them (lower-case keys).
  const wrapped = (extra = {}) => ({
    from: `"Stripe 'billing@stripe.example' via 33Mail" <${WRAPPER}>`,
    'x-33mail-original-to': 'shop@myname.33mail.com',
    'list-unsubscribe': '<mailto:unsubscribe-abc123@unsub.33mail.com>',
    'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    ...extra,
  });

  it('ignores the forwarder\'s own List-Unsubscribe (plain wrapped mail is not bulk)', () => {
    expect(detectCategoryFromHeaders(wrapped())).toBeNull();
    expect(detectBulkFromParsedHeaders(wrapped())).toBe(false);
  });

  it('lets surviving original headers decide: Auto-Submitted → automated', () => {
    expect(detectCategoryFromHeaders(wrapped({ 'auto-submitted': 'auto-generated' }))).toBe('automated');
  });

  it('lets surviving original headers decide: List-Id → newsletter', () => {
    const h = wrapped({ 'list-id': '<weekly.news.example>' });
    expect(detectCategoryFromHeaders(h)).toBe('newsletter');
    expect(detectBulkFromParsedHeaders(h)).toBe(true);
  });

  it('applies the noreply check to the original sender', () => {
    const h = wrapped({ from: `"'noreply@shop.example' via 33Mail" <${WRAPPER}>` });
    expect(detectCategoryFromHeaders(h)).toBe('automated');
  });

  it('keeps a List-Unsubscribe that also points somewhere else (the original survived)', () => {
    const h = wrapped({ 'list-unsubscribe': '<mailto:u@unsub.33mail.com>, <https://news.example/unsub>' });
    expect(detectCategoryFromHeaders(h)).toBe('newsletter');
  });

  it('does not strip anything on non-forwarder mail, even with a 33Mail-looking header', () => {
    const h = {
      from: "\"PayPal 'service@paypal.com' via 33Mail\" <attacker@evil.example>",
      'list-unsubscribe': '<mailto:u@unsub.33mail.com>',
    };
    expect(unwrapForwarderHeaders(h)).toBe(h);
    expect(detectCategoryFromHeaders(h)).toBe('newsletter');
  });

  it('exposes the headers a partial fetch needs for detection', () => {
    expect(ALIAS_FORWARDER_HEADERS).toEqual(expect.arrayContaining(['from', 'x-33mail-original-to']));
  });
});
