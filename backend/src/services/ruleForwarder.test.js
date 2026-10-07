import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(),
}));

import { createHash, createHmac, hkdfSync } from 'crypto';
import nodemailer from 'nodemailer';
import { query } from './db.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { parseRawHeaders } from './messageParser.js';
import {
  buildForwardMessage,
  forwardRuleMessage,
} from './ruleForwarder.js';

const account = {
  id: 'account-1',
  sender_name: 'Mailbox',
  email_address: 'mailbox@example.com',
};
const storedAttachments = [
  {
    part: '2',
    filename: 'invoice.pdf',
    type: 'application/pdf',
    encoding: 'base64',
    size: 7,
  },
  {
    part: '3',
    filename: 'notes.txt',
    type: 'text/plain',
    encoding: 'quoted-printable',
    size: 5,
  },
];
const messageRow = {
  id: 'message-1',
  account_id: account.id,
  uid: 42,
  folder: 'INBOX',
  subject: 'Quarterly review',
  from_name: 'Example Sender',
  from_email: 'sender@example.com',
  to_addresses: [{ address: 'team@example.com' }],
  cc_addresses: [],
  date: '2026-07-29T12:00:00.000Z',
  body_text: 'Original body',
  body_html: '<p>Original body</p>',
  attachments: [],
};

// The headers sync hands the rules when a sent forward lands in a mailbox: the message as
// nodemailer writes it, read back by the parser sync uses.
async function deliveredHeaders(mail) {
  const { message } = await nodemailer
    .createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    .sendMail(mail);
  return parseRawHeaders(message.subarray(0, message.indexOf('\r\n\r\n')));
}

// The loop token is keyed with a key derived from ENCRYPTION_KEY, which index.js requires.
const KEY = 'a1'.repeat(32);
const OTHER_KEY = '5e'.repeat(32);

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildForwardMessage', () => {
  it('builds a PII-free-shape Fwd message and escapes forwarded headers', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Quarterly <review>',
        from_name: 'Example <Sender>',
        from_email: 'sender@example.com',
        to_addresses: [{ address: 'team@example.com' }],
        cc_addresses: [],
        date: '2026-07-29T12:00:00.000Z',
      },
      account: {
        sender_name: 'Mailbox',
        email_address: 'mailbox@example.com',
      },
      recipient: 'recipient@example.com',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      attachments: [],
    });

    expect(mail).toMatchObject({
      from: 'Mailbox <mailbox@example.com>',
      to: 'recipient@example.com',
      subject: 'Fwd: Quarterly <review>',
    });
    expect(mail.text).toContain('---------- Forwarded message ----------');
    expect(mail.text).toContain('Plain body');
    expect(mail.html).toContain('Example &lt;Sender&gt;');
    expect(mail.html).toContain('<p>HTML body</p>');
    // Same software declaration as composed mail (#492): a forward leaves through the same
    // strict outbound filters that treat header-less mail as a botnet signature.
    expect(mail.xMailer).toMatch(/^MailFlow \d+\.\d+\.\d+$/);
  });

  it('does not add a second Fwd prefix', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Fwd: Existing',
        from_name: '',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account: {
        name: 'Mailbox',
        email_address: 'mailbox@example.com',
      },
      recipient: 'recipient@example.com',
      text: '',
      html: null,
      attachments: [],
    });
    expect(mail.subject).toBe('Fwd: Existing');
  });

  it('derives a readable text alternative for HTML-only messages', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'HTML only',
        from_name: 'Example Sender',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account,
      recipient: 'recipient@example.com',
      text: '',
      html: '<p>Hello <strong>there</strong></p><p>Second&nbsp;line</p>',
      attachments: [],
    });

    expect(mail.text).toContain('Hello there');
    expect(mail.text).toContain('Second line');
  });

  it('preserves a text-only body without adding an HTML alternative', () => {
    const mail = buildForwardMessage({
      row: {
        subject: 'Text only',
        from_name: 'Example Sender',
        from_email: 'sender@example.com',
        to_addresses: [],
        cc_addresses: [],
        date: null,
      },
      account,
      recipient: 'recipient@example.com',
      text: 'Plain body only',
      html: null,
      attachments: [],
    });

    expect(mail.text).toContain('Plain body only');
    expect(mail).not.toHaveProperty('html');
  });

  it('keys the loop token with a key derived from ENCRYPTION_KEY', async () => {
    const tokenUnder = async key => {
      vi.resetModules();
      vi.stubEnv('ENCRYPTION_KEY', key);
      const forwarder = await import('./ruleForwarder.js');
      return forwarder.buildForwardMessage({
        row: messageRow,
        account,
        recipient: 'recipient@example.com',
        text: 'Plain body',
      }).headers['X-MailFlow-Loop'];
    };
    const token = await tokenUnder(KEY);

    // Only this instance can compute it: an HMAC of the address under the HKDF-derived key.
    const derived = Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY, 'hex'), Buffer.alloc(0), 'mailflow:rule-forward-loop', 32)
    );
    expect(token).toBe(createHmac('sha256', derived)
      .update(account.email_address)
      .digest('hex')
      .slice(0, 16));
    expect(await tokenUnder(OTHER_KEY)).not.toBe(token);
  });
});

describe('forwardRuleMessage', () => {
  let transport;
  let imapManager;
  let input;

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    transport = { sendMail: vi.fn().mockResolvedValue({ accepted: true }) };
    createAccountSmtpTransport.mockResolvedValue({ account, transport });
    imapManager = {
      fetchMessageBody: vi.fn(),
      fetchMultipleAttachments: vi.fn().mockResolvedValue(new Map()),
    };
    input = {
      ruleId: 'rule-1',
      message: { id: messageRow.id },
      account,
      imapManager,
      recipient: 'recipient@example.com',
    };
  });

  it('reserves, sends once, and marks the delivery sent', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.at(-1)[0]).toContain("status = 'sent'");
  });

  it('returns duplicate without sending when the existing reservation is sent', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'sent' }] });

    await expect(forwardRuleMessage(input)).resolves.toBe('duplicate');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('SELECT status');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('rejects a pending reservation without starting another delivery', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
    expect(query).toHaveBeenCalledTimes(2);
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('allows only one SMTP attempt while another run owns the pending reservation', async () => {
    let reservationCreated = false;
    let reservationStatus = 'pending';
    let notifyDeliveryStarted;
    let releaseDelivery;
    const deliveryStarted = new Promise(resolve => {
      notifyDeliveryStarted = resolve;
    });
    transport.sendMail.mockImplementation(() => {
      notifyDeliveryStarted();
      return new Promise(resolve => {
        releaseDelivery = resolve;
      });
    });
    query.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO inbox_rule_forwards')) {
        if (reservationCreated) return { rows: [] };
        reservationCreated = true;
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('SELECT status')) {
        return { rows: [{ status: reservationStatus }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [messageRow] };
      }
      if (sql.includes('UPDATE inbox_rule_forwards')) {
        reservationStatus = 'sent';
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    const firstRun = forwardRuleMessage(input);
    await deliveryStarted;

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery pending');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(createAccountSmtpTransport).toHaveBeenCalledTimes(1);

    releaseDelivery({ accepted: true });
    await expect(firstRun).resolves.toBe('sent');
    expect(reservationStatus).toBe('sent');
  });

  it('deletes a pending reservation after a known pre-delivery failure', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockRejectedValueOnce(new Error('body unavailable'))
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('body unavailable');
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('keeps the reservation when recording success fails after SMTP delivery', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(forwardRuleMessage(input)).rejects.toThrow('database unavailable');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('fetches only stored attachment parts once and preserves their metadata', async () => {
    const pdf = Buffer.from('pdfdata');
    const notes = Buffer.from('notes');
    const row = {
      ...messageRow,
      attachments: JSON.stringify(storedAttachments),
    };
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', pdf],
      ['3', notes],
    ]));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');

    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledTimes(1);
    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
      account,
      messageRow.uid,
      messageRow.folder,
      storedAttachments
    );
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [
        {
          filename: 'invoice.pdf',
          content: pdf,
          contentType: 'application/pdf',
        },
        {
          filename: 'notes.txt',
          content: notes,
          contentType: 'text/plain',
        },
      ],
    }));
  });

  it('fetches an uncached body, sanitizes HTML, and embeds inline data images', async () => {
    const pdf = Buffer.from('pdfdata');
    const row = {
      ...messageRow,
      body_text: '',
      body_html: null,
      attachments: [storedAttachments[0]],
    };
    imapManager.fetchMessageBody.mockResolvedValue({
      text: 'Secret original body',
      html: '<p onclick="alert(1)">Secret original body<img src="data:image/png;base64,QUJD"></p><script>alert(1)</script>',
      attachments: [{ ...storedAttachments[0], filename: 'duplicate.pdf' }],
    });
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', pdf],
    ]));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    const consoleSpies = ['log', 'info', 'warn', 'error'].map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}));

    try {
      await expect(forwardRuleMessage(input)).resolves.toBe('sent');

      expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(
        account,
        messageRow.uid,
        messageRow.folder
      );
      expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
        account,
        messageRow.uid,
        messageRow.folder,
        [storedAttachments[0]]
      );
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.html).not.toContain('<script');
      expect(mail.html).not.toContain('onclick=');
      expect(mail.html).not.toContain('data:image');
      expect(mail.html).toMatch(/src="cid:img-[a-f0-9]+-0@mailflow"/);
      expect(mail.attachments).toEqual([
        expect.objectContaining({
          filename: 'image-0.png',
          content: Buffer.from('ABC'),
          contentDisposition: 'inline',
          contentType: 'image/png',
        }),
        {
          filename: 'invoice.pdf',
          content: pdf,
          contentType: 'application/pdf',
        },
      ]);
      const consoleOutput = consoleSpies
        .flatMap(spy => spy.mock.calls.flat())
        .map(value => String(value))
        .join(' ');
      expect(consoleOutput).not.toContain(input.recipient);
      expect(consoleOutput).not.toContain('Secret original body');
      expect(consoleOutput).not.toContain('invoice.pdf');
    } finally {
      consoleSpies.forEach(spy => spy.mockRestore());
    }
  });

  it('forwards attachment metadata discovered while fetching an uncached body', async () => {
    const pdf = Buffer.from('pdfdata');
    const fetchedAttachment = {
      part: '4',
      filename: 'discovered.pdf',
      type: 'application/pdf',
      encoding: 'base64',
      size: pdf.length,
    };
    const row = {
      ...messageRow,
      body_text: '',
      body_html: null,
      attachments: [],
    };
    imapManager.fetchMessageBody.mockResolvedValue({
      text: 'Fetched body',
      html: '<p>Fetched body</p>',
      attachments: [fetchedAttachment],
    });
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['4', pdf],
    ]));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');

    expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
      account,
      messageRow.uid,
      messageRow.folder,
      [fetchedAttachment]
    );
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        filename: 'discovered.pdf',
        content: pdf,
        contentType: 'application/pdf',
      }],
    }));
  });

  it('rejects attachments larger than 25 MiB before SMTP delivery', async () => {
    const row = {
      ...messageRow,
      attachments: [{
        part: '2',
        filename: 'large.bin',
        type: 'application/octet-stream',
        encoding: 'base64',
        size: 0,
      }],
    };
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', Buffer.alloc((25 * 1024 * 1024) + 1)],
    ]));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Total attachment size exceeds 25 MB');
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('rejects declared attachment sizes over 25 MiB before fetching bytes', async () => {
    const row = {
      ...messageRow,
      attachments: [{
        part: '2',
        filename: 'declared-large.bin',
        type: 'application/octet-stream',
        size: (25 * 1024 * 1024) + 1,
      }],
    };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Total attachment size exceeds 25 MB');
    expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('deletes the reservation when an attachment buffer is unavailable', async () => {
    const row = {
      ...messageRow,
      attachments: [storedAttachments[0]],
    };
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map());
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input))
      .rejects.toThrow('Forward attachment unavailable');
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('deletes the reservation when SMTP setup returns a safe error', async () => {
    createAccountSmtpTransport.mockResolvedValue({
      error: 'SMTP is unavailable',
    });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('SMTP is unavailable');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('DELETE FROM inbox_rule_forwards');
  });

  it('clears a failed delivery reservation so a retry can send', async () => {
    const unsafeMessage = 'timeout after DATA for recipient@example.com';
    let reservationStatus = null;
    transport.sendMail
      .mockRejectedValueOnce(new Error(unsafeMessage))
      .mockResolvedValueOnce({ accepted: true });
    query.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO inbox_rule_forwards')) {
        if (reservationStatus) return { rows: [] };
        reservationStatus = 'pending';
        return { rows: [{ id: 'delivery-1' }] };
      }
      if (sql.includes('SELECT status')) {
        return { rows: [{ status: reservationStatus }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [messageRow] };
      }
      if (sql.includes('DELETE FROM inbox_rule_forwards')) {
        reservationStatus = null;
        return { rows: [] };
      }
      if (sql.includes('UPDATE inbox_rule_forwards')) {
        reservationStatus = 'sent';
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    let thrown;
    try {
      await forwardRuleMessage(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('Forward delivery failed');
    expect(thrown.message).not.toContain('recipient@example.com');
    expect(thrown.message).not.toContain(unsafeMessage);
    expect(thrown.cause).toBeUndefined();
    await expect(forwardRuleMessage(input)).resolves.toBe('sent');
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(createAccountSmtpTransport).toHaveBeenCalledTimes(2);
    expect(reservationStatus).toBe('sent');
  });

  // Every forward gets a reservation and the same source row.
  function reserveEveryForward() {
    query.mockImplementation(async sql => ({
      rows: sql.includes('INSERT INTO inbox_rule_forwards')
        ? [{ id: 'delivery-1' }]
        : sql.includes('FROM messages') ? [messageRow] : [],
    }));
  }

  it('stops a forward that comes back to a mailbox that already forwarded it', async () => {
    const upstream = { ...account, id: 'account-0', email_address: 'upstream@example.net' };
    const second = { ...account, id: 'account-2', email_address: 'second@example.org' };
    const third = { ...account, id: 'account-3', email_address: 'third@example.org' };
    const hops = [[upstream, account], [account, second], [second, third], [third, account]];
    reserveEveryForward();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      let parsedHeaders;
      for (const [index, [from, to]] of hops.entries()) {
        await expect(forwardRuleMessage({
          ...input,
          ruleId: `rule-${index}`,
          account: from,
          recipient: to.email_address,
          message: { id: `message-${index}`, parsedHeaders },
        })).resolves.toBe('sent');
        parsedHeaders = await deliveredHeaders(transport.sendMail.mock.calls[index][0]);
      }
      const queriesBeforeReturn = query.mock.calls.length;

      await expect(forwardRuleMessage({
        ...input,
        recipient: second.email_address,
        message: { id: 'message-4', parsedHeaders },
      })).resolves.toBe('loop');

      expect(query).toHaveBeenCalledTimes(queriesBeforeReturn);
      expect(transport.sendMail).toHaveBeenCalledTimes(hops.length);
      const tokens = parsedHeaders['x-mailflow-loop'].split(', ');
      expect(tokens).toHaveLength(hops.length);
      expect(new Set(tokens).size).toBe(hops.length);
      for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{16}$/);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.flat().join(' ');
      for (const [from] of hops) expect(logged).not.toContain(from.email_address);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops a loop through ten mailboxes, the most a forward records', async () => {
    const mailboxes = Array.from({ length: 10 }, (_, index) => ({
      ...account,
      id: `account-${index}`,
      email_address: `mailbox${index}@example.org`,
    }));
    reserveEveryForward();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      let parsedHeaders;
      for (const [index, from] of mailboxes.entries()) {
        await expect(forwardRuleMessage({
          ...input,
          ruleId: `rule-${index}`,
          account: from,
          recipient: mailboxes[(index + 1) % mailboxes.length].email_address,
          message: { id: `message-${index}`, parsedHeaders },
        })).resolves.toBe('sent');
        parsedHeaders = await deliveredHeaders(transport.sendMail.mock.calls[index][0]);
      }
      expect(parsedHeaders['x-mailflow-loop'].split(', ')).toHaveLength(10);

      // Back at the first mailbox, whose token is now the oldest one kept.
      await expect(forwardRuleMessage({
        ...input,
        ruleId: 'rule-0',
        account: mailboxes[0],
        recipient: mailboxes[1].email_address,
        message: { id: 'message-10', parsedHeaders },
      })).resolves.toBe('loop');
      expect(transport.sendMail).toHaveBeenCalledTimes(mailboxes.length);
    } finally {
      warn.mockRestore();
    }
  });

  it('passes on the nine newest well-formed tokens, so added tokens cannot stop a forward', async () => {
    const added = Array.from({ length: 12 }, (_, i) => i.toString(16).repeat(16));
    // A token anyone could compute from the address: an unkeyed hash of it.
    const fromAddress = createHash('sha256')
      .update(`mailflow-loop:${account.email_address}`)
      .digest('hex')
      .slice(0, 16);
    reserveEveryForward();

    await expect(forwardRuleMessage({
      ...input,
      message: {
        id: 'message-2',
        parsedHeaders: parseRawHeaders(
          `X-MailFlow-Loop: ${[...added, fromAddress, 'mailbox@example.com'].join(', ')}`
        ),
      },
    })).resolves.toBe('sent');

    const delivered = await deliveredHeaders(transport.sendMail.mock.calls[0][0]);
    const tokens = delivered['x-mailflow-loop'].split(', ');
    expect(tokens.slice(0, -1)).toEqual([...added.slice(-8), fromAddress]);
    expect(tokens.at(-1)).toMatch(/^[0-9a-f]{16}$/);
    expect([...added, fromAddress]).not.toContain(tokens.at(-1));
  });

  it('reserves and sends nothing without a valid ENCRYPTION_KEY', async () => {
    vi.resetModules();
    vi.stubEnv('ENCRYPTION_KEY', '');
    const { forwardRuleMessage: forward } = await import('./ruleForwarder.js');
    const { query: freshQuery } = await import('./db.js');
    const { createAccountSmtpTransport: freshSmtp } = await import('./smtpTransport.js');

    await expect(forward(input)).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(freshQuery).not.toHaveBeenCalled();
    expect(freshSmtp).not.toHaveBeenCalled();
  });
});
