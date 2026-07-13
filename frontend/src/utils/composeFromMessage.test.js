import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openReplyFromMessage, openForwardFromMessage } from './composeFromMessage.js';

// Capture the single openCompose payload the util emits. getMessageBody resolves to
// the given body (or null, standing in for a fetch that failed and was swallowed).
function harness(body = null) {
  let payload = null;
  return {
    openCompose: (p) => { payload = p; },
    getMessageBody: () => Promise.resolve(body),
    payload: () => payload,
  };
}

describe('openReplyFromMessage reply target', () => {
  it('prefers reply_to[0] over from', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', reply_to: [{ name: 'R', email: 'r@x.com' }], from_name: 'F', from_email: 'f@x.com' },
      { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.deepEqual(h.payload().to, [{ name: 'R', email: 'r@x.com' }]);
    assert.deepEqual(h.payload().originalFrom, [{ name: 'R', email: 'r@x.com' }]);
  });

  it('falls back to from when reply_to has no email', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', reply_to: [], from_name: 'F', from_email: 'f@x.com' },
      { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.deepEqual(h.payload().to, [{ name: 'F', email: 'f@x.com' }]);
  });

  it('parses reply_to as a JSON string or an array alike', async () => {
    for (const reply_to of ['[{"email":"r@x.com"}]', [{ email: 'r@x.com' }]]) {
      const h = harness();
      await openReplyFromMessage(
        { account_id: 'a', reply_to, from_email: 'f@x.com' },
        { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
      );
      assert.deepEqual(h.payload().to, [{ email: 'r@x.com' }]);
    }
  });
});

describe('openReplyFromMessage alias selection', () => {
  const account = {
    id: 'a',
    email_address: 'me@x.com',
    aliases: [{ id: 'al1', email: 'alias1@x.com' }, { id: 'al2', email: 'alias2@x.com' }],
  };

  it('matches an alias against a to/cc recipient', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', from_email: 'f@x.com', to_addresses: [{ email: 'alias2@x.com' }] },
      { accounts: [account], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().aliasId, 'al2');
  });

  it('matches an alias against the from address, case-insensitively', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', from_email: 'Alias1@x.com', to_addresses: [] },
      { accounts: [account], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().aliasId, 'al1');
  });

  it('is null when no alias matches', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', from_email: 'f@x.com', to_addresses: [{ email: 'someone@x.com' }] },
      { accounts: [account], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().aliasId, null);
  });
});

describe('openReplyFromMessage reply-all recipients', () => {
  const account = { id: 'a', email_address: 'me@x.com', aliases: [{ id: 'al1', email: 'alias@x.com' }] };
  const message = {
    account_id: 'a',
    reply_to: [{ email: 'sender@x.com' }],
    from_email: 'sender@x.com',
    to_addresses: [{ email: 'ME@x.com' }, { email: 'alias@x.com' }, { email: 'sender@x.com' }, { email: 'keep@x.com' }],
    cc_addresses: [{ email: 'cckeep@x.com' }],
  };

  it('drops own address, aliases, and the reply target', async () => {
    const h = harness();
    await openReplyFromMessage(message, {
      accounts: [account], openCompose: h.openCompose, getMessageBody: h.getMessageBody, replyAll: true,
    });
    assert.deepEqual(h.payload().cc, [{ email: 'keep@x.com' }, { email: 'cckeep@x.com' }]);
    assert.deepEqual(h.payload().allRecipients, [{ email: 'keep@x.com' }, { email: 'cckeep@x.com' }]);
  });

  it('leaves cc empty for a plain reply but still computes allRecipients', async () => {
    const h = harness();
    await openReplyFromMessage(message, {
      accounts: [account], openCompose: h.openCompose, getMessageBody: h.getMessageBody,
    });
    assert.deepEqual(h.payload().cc, []);
    assert.deepEqual(h.payload().allRecipients, [{ email: 'keep@x.com' }, { email: 'cckeep@x.com' }]);
  });
});

describe('subject prefixing', () => {
  it('adds Re: unless already present', async () => {
    for (const [subject, expected] of [['Hello', 'Re: Hello'], ['Re: Hello', 'Re: Hello'], ['', 'Re:']]) {
      const h = harness();
      await openReplyFromMessage(
        { account_id: 'a', reply_to: [], from_email: 'f@x.com', subject },
        { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
      );
      assert.equal(h.payload().subject, expected);
    }
  });

  it('adds Fwd: unless already present', async () => {
    for (const [subject, expected] of [['Hello', 'Fwd: Hello'], ['Fwd: Hello', 'Fwd: Hello']]) {
      const h = harness({ text: '', html: null, attachments: [] });
      await openForwardFromMessage(
        { account_id: 'a', subject },
        { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
      );
      assert.equal(h.payload().subject, expected);
    }
  });
});

describe('references chain', () => {
  it('joins in_reply_to and message_id', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', reply_to: [], from_email: 'f@x.com', in_reply_to: '<a>', message_id: '<b>' },
      { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().references, '<a> <b>');
    assert.equal(h.payload().inReplyTo, '<b>');
  });

  it('uses message_id alone when there is no in_reply_to', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', reply_to: [], from_email: 'f@x.com', message_id: '<b>' },
      { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().references, '<b>');
  });

  it('is null when neither header is present', async () => {
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', reply_to: [], from_email: 'f@x.com' },
      { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().references, null);
  });
});

describe('openForwardFromMessage', () => {
  it('includes To/Cc lines only when present', async () => {
    const h = harness({ text: 'BODY', html: null, attachments: [] });
    await openForwardFromMessage(
      {
        account_id: 'a', subject: 'S', from_email: 'f@x.com',
        to_addresses: [{ email: 'to@x.com' }], cc_addresses: [{ name: 'C', email: 'cc@x.com' }],
      },
      { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.match(h.payload().quotedBody, /\nTo: to@x\.com/);
    assert.match(h.payload().quotedBody, /\nCc: C <cc@x\.com>/);
  });

  it('omits To/Cc lines when the fields are empty', async () => {
    const h = harness({ text: 'BODY', html: null, attachments: [] });
    await openForwardFromMessage(
      { account_id: 'a', subject: 'S', from_email: 'f@x.com', to_addresses: [], cc_addresses: [] },
      { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.doesNotMatch(h.payload().quotedBody, /\nTo:/);
    assert.doesNotMatch(h.payload().quotedBody, /\nCc:/);
  });

  it('maps fetched attachments into forwardedAttachments', async () => {
    const h = harness({ text: 'BODY', html: null, attachments: [{ part: '2', filename: 'a.pdf', type: 'application/pdf', size: 10 }] });
    await openForwardFromMessage(
      { id: 'm1', account_id: 'a', subject: 'S', from_email: 'f@x.com' },
      { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.deepEqual(h.payload().forwardedAttachments, [
      { messageId: 'm1', part: '2', filename: 'a.pdf', type: 'application/pdf', size: 10 },
    ]);
  });
});

describe('malformed address fields fall back cleanly', () => {
  it('reply parses nothing and still emits a payload', async () => {
    const account = { id: 'a', email_address: 'me@x.com', aliases: [{ id: 'al1', email: 'alias@x.com' }] };
    const h = harness();
    await openReplyFromMessage(
      { account_id: 'a', reply_to: 'not json', from_email: 'f@x.com', to_addresses: '{bad', cc_addresses: 'nope' },
      { accounts: [account], openCompose: h.openCompose, getMessageBody: h.getMessageBody, replyAll: true },
    );
    const p = h.payload();
    assert.deepEqual(p.to, [{ name: '', email: 'f@x.com' }]);
    assert.equal(p.aliasId, null);
    assert.deepEqual(p.allRecipients, []);
    assert.deepEqual(p.cc, []);
  });

  it('forward drops the To/Cc lines for malformed fields', async () => {
    const h = harness({ text: 'BODY', html: null, attachments: [] });
    await openForwardFromMessage(
      { account_id: 'a', subject: 'S', from_email: 'f@x.com', to_addresses: '{bad', cc_addresses: 'nope' },
      { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.doesNotMatch(h.payload().quotedBody, /\nTo:/);
    assert.doesNotMatch(h.payload().quotedBody, /\nCc:/);
  });
});

// The quoted-body templates are the part a reader can least eyeball from the call
// sites, so pin them exactly — attribution line, delimiters, quoting, wrapper markup
// and the text-vs-html fallbacks — not just fragments.
describe('quoted body templates', () => {
  const date = '2026-07-13T10:00:00Z';
  const when = new Date(date).toLocaleString();

  it('builds the exact reply quoted text and html, sanitizing newlines in the name', async () => {
    const h = harness({ text: 'line1\nline2', html: '<p>Hi</p>' });
    await openReplyFromMessage(
      { account_id: 'a', date, from_name: 'Bad\nActor', from_email: 'f@x.com' },
      { accounts: [], openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(
      h.payload().quotedBody,
      `\n\n---\nOn ${when}, Bad Actor <f@x.com> wrote:\n> line1\n> line2`,
    );
    assert.equal(
      h.payload().quotedBodyHtml,
      `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${when}, Bad Actor <f@x.com> wrote:</p><p>Hi</p></div>`,
    );
  });

  it('reply falls back per part: no text leaves quotedBody empty, no html leaves quotedBodyHtml null', async () => {
    const htmlOnly = harness({ html: '<p>Hi</p>' });
    await openReplyFromMessage(
      { account_id: 'a', date, from_email: 'f@x.com' },
      { accounts: [], openCompose: htmlOnly.openCompose, getMessageBody: htmlOnly.getMessageBody },
    );
    assert.equal(htmlOnly.payload().quotedBody, '');

    const textOnly = harness({ text: 'hey' });
    await openReplyFromMessage(
      { account_id: 'a', date, from_email: 'f@x.com' },
      { accounts: [], openCompose: textOnly.openCompose, getMessageBody: textOnly.getMessageBody },
    );
    assert.equal(textOnly.payload().quotedBodyHtml, null);
  });

  it('builds the exact forwarded text and html including To/Cc lines', async () => {
    const h = harness({ text: 'body', html: '<p>body</p>' });
    await openForwardFromMessage(
      {
        id: 'm1', date, from_name: 'Ann', from_email: 'ann@x.com', subject: 'Hello',
        to_addresses: [{ name: 'Bob', email: 'bob@x.com' }],
        cc_addresses: [{ email: 'cc@x.com' }],
      },
      { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(
      h.payload().quotedBody,
      `\n\n---------- Forwarded message ----------\nFrom: Ann <ann@x.com>\nDate: ${when}\nSubject: Hello\nTo: Bob <bob@x.com>\nCc: cc@x.com\n\nbody`,
    );
    assert.equal(
      h.payload().quotedBodyHtml,
      `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: Ann <ann@x.com><br>Date: ${when}<br>Subject: Hello<br>To: Bob <bob@x.com><br>Cc: cc@x.com</p><p>body</p></div>`,
    );
  });

  it('forward without an html body leaves quotedBodyHtml null but keeps the text scaffold', async () => {
    const h = harness({ text: 'plain' });
    await openForwardFromMessage(
      { id: 'm1', date, from_email: 'ann@x.com', subject: 'Hello' },
      { openCompose: h.openCompose, getMessageBody: h.getMessageBody },
    );
    assert.equal(h.payload().quotedBodyHtml, null);
    assert.equal(
      h.payload().quotedBody,
      `\n\n---------- Forwarded message ----------\nFrom: ann@x.com\nDate: ${when}\nSubject: Hello\n\nplain`,
    );
  });
});
