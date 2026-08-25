import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const revalidateLiveMessageSnapshots = vi.hoisted(() => vi.fn());

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageSnapshots.js', async importOriginal => ({
  ...(await importOriginal()),
  revalidateLiveMessageSnapshots,
}));
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(),
}));

import { query } from './db.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
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
  folder_uid_validity: '101',
  folder_observation_generation: '9',
  read_revision: '3',
  star_revision: '5',
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

function deliveredRaw(transport) {
  return Buffer.from(transport.sendMail.mock.calls[0][0].raw).toString();
}

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
});

describe('forwardRuleMessage', () => {
  let transport;
  let imapManager;
  let input;

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    revalidateLiveMessageSnapshots.mockReset().mockResolvedValue(undefined);
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
    const completionSql = query.mock.calls.at(-1)[0];
    expect(completionSql).toContain("status = 'sent'");
    expect(completionSql).toMatch(/recipient\s*=\s*NULL/i);
    expect(completionSql).toMatch(/smtp_message\s*=\s*NULL/i);
    expect(completionSql).toMatch(/smtp_envelope\s*=\s*NULL/i);
    expect(completionSql).toMatch(/source_snapshot\s*=\s*NULL/i);
  });

  it('does not send fetched body or attachments after the exact source snapshot relocates', async () => {
    const uncached = { ...messageRow, body_text: null, body_html: null, attachments: storedAttachments };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [uncached] })
      .mockResolvedValueOnce({ rows: [] });
    imapManager.fetchMessageBody.mockResolvedValue({
      text: 'stale body', html: '<p>stale body</p>', attachments: storedAttachments,
    });
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([
      ['2', Buffer.from('invoice')], ['3', Buffer.from('notes')],
    ]));
    revalidateLiveMessageSnapshots.mockRejectedValue(Object.assign(
      new Error('Message snapshot was relocated or superseded'),
      { code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: true },
    ));

    await expect(forwardRuleMessage(input)).rejects.toMatchObject({
      code: 'MESSAGE_SNAPSHOT_SUPERSEDED',
    });
    expect(revalidateLiveMessageSnapshots).toHaveBeenCalledWith(account.id, [expect.objectContaining({
      id: messageRow.id, uid: 42, folder: 'INBOX', uidValidity: '101', folderGeneration: '9',
    })]);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('validates the exact source immediately before and after SMTP delivery', async () => {
    const events = [];
    let reservationStatus = 'ready';
    revalidateLiveMessageSnapshots.mockImplementation(async () => {
      events.push(transport.sendMail.mock.calls.length ? 'validate-post' : 'validate-pre');
    });
    transport.sendMail.mockImplementation(async () => {
      events.push('smtp');
      return { accepted: true };
    });
    query.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO inbox_rule_forwards')) return { rows: [{ id: 'delivery-1' }] };
      if (sql.includes('FROM messages')) return { rows: [messageRow] };
      if (sql.includes('SET recipient =')) return { rows: [], rowCount: 1 };
      if (sql.includes("SET status = 'provider_started'")) {
        reservationStatus = 'provider_started';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'sent'")) {
        reservationStatus = 'sent';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      throw new Error('Unexpected query');
    });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');

    expect(events).toEqual(['validate-pre', 'validate-pre', 'smtp', 'validate-post']);
    expect(reservationStatus).toBe('sent');
  });

  it('keeps a known SMTP submission sent when the post-delivery source fence is superseded', async () => {
    const events = [];
    let reservationStatus = 'ready';
    revalidateLiveMessageSnapshots
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(
        new Error('Message snapshot was relocated or superseded'),
        { code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: true },
      ));
    query.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO inbox_rule_forwards')) return { rows: [{ id: 'delivery-1' }] };
      if (sql.includes('FROM messages')) return { rows: [messageRow] };
      if (sql.includes('SET recipient =')) return { rows: [], rowCount: 1 };
      if (sql.includes("SET status = 'provider_started'")) {
        reservationStatus = 'provider_started';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'sent'")) {
        events.push('sent');
        reservationStatus = 'sent';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'uncertain'")) {
        reservationStatus = 'uncertain';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      throw new Error('Unexpected query');
    });

    await expect(forwardRuleMessage(input)).rejects.toMatchObject({
      code: 'MESSAGE_SNAPSHOT_SUPERSEDED',
    });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(revalidateLiveMessageSnapshots).toHaveBeenCalledTimes(3);
    expect(events).toEqual(['sent']);
    expect(reservationStatus).toBe('sent');
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

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery outcome is uncertain');
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
      if (sql.includes('SET recipient =')) return { rows: [], rowCount: 1 };
      if (sql.includes("SET status = 'provider_started'")) {
        reservationStatus = 'provider_started';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE inbox_rule_forwards')) {
        reservationStatus = 'sent';
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    });

    const firstRun = forwardRuleMessage(input);
    await deliveryStarted;

    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery outcome is uncertain');
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

  it('marks the reservation uncertain when recording success fails after SMTP delivery', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }], rowCount: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }], rowCount: 1 });

    await expect(forwardRuleMessage(input)).rejects.toThrow('database unavailable');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls.at(-1)[0]).toContain("SET status = 'uncertain'");
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
      storedAttachments,
      { snapshot: expect.objectContaining({ id: messageRow.id, uid: messageRow.uid }) },
    );
    const raw = deliveredRaw(transport);
    expect(raw).toContain('invoice.pdf');
    expect(raw).toContain('cGRmZGF0YQ==');
    expect(raw).toContain('notes.txt');
    expect(raw).toContain('bm90ZXM=');
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
        messageRow.folder,
        { snapshot: {
          id: messageRow.id, accountId: account.id, uid: messageRow.uid, folder: messageRow.folder,
          uidValidity: '101', folderGeneration: '9', readRevision: 3, starRevision: 5,
        } }
      );
      expect(imapManager.fetchMultipleAttachments).toHaveBeenCalledWith(
        account,
        messageRow.uid,
        messageRow.folder,
        [storedAttachments[0]],
        { snapshot: {
          id: messageRow.id, accountId: account.id, uid: messageRow.uid, folder: messageRow.folder,
          uidValidity: '101', folderGeneration: '9', readRevision: 3, starRevision: 5,
        } }
      );
      const raw = deliveredRaw(transport);
      expect(raw).not.toContain('<script');
      expect(raw).not.toContain('onclick=');
      expect(raw).not.toContain('data:image');
      expect(raw).toMatch(/cid:img-[a-f0-9]+-0@mailflow/);
      expect(raw).toContain('image-0.png');
      expect(raw).toContain('QUJD');
      expect(raw).toContain('invoice.pdf');
      expect(raw).toContain('cGRmZGF0YQ==');
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
      [fetchedAttachment],
      { snapshot: expect.objectContaining({ id: messageRow.id, uid: messageRow.uid }) },
    );
    const raw = deliveredRaw(transport);
    expect(raw).toContain('discovered.pdf');
    expect(raw).toContain('cGRmZGF0YQ==');
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

  it('retains the exact prepared reservation when SMTP setup fails before provider start', async () => {
    createAccountSmtpTransport.mockResolvedValue({
      error: 'SMTP is unavailable',
    });
    query
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [messageRow] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(forwardRuleMessage(input)).rejects.toThrow('SMTP is unavailable');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)[0]).toContain('SET recipient =');
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM inbox_rule_forwards'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("SET status = 'uncertain'"))).toBe(false);
  });

  it('retains an uncertain SMTP reservation so a retry cannot duplicate delivery', async () => {
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
        throw new Error('uncertain reservation must not be deleted');
      }
      if (sql.includes("SET status = 'provider_started'")) {
        reservationStatus = 'provider_started';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'uncertain'")) {
        reservationStatus = 'uncertain';
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
    await expect(forwardRuleMessage(input)).rejects.toThrow('Forward delivery outcome is uncertain');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(createAccountSmtpTransport).toHaveBeenCalledTimes(1);
    expect(reservationStatus).toBe('uncertain');
  });

  it('replays the exact durably prepared SMTP bytes without rebuilding message content', async () => {
    const raw = Buffer.from('From: mailbox@example.com\r\nTo: recipient@example.com\r\n\r\nfrozen');
    const envelope = { from: 'mailbox@example.com', to: ['recipient@example.com'] };
    const digest = createHash('sha256')
      .update(raw)
      .update('\0')
      .update('{"from":"mailbox@example.com","to":["recipient@example.com"]}')
      .digest('hex');
    const sourceSnapshot = {
      id: messageRow.id, accountId: account.id, uid: 42, folder: 'INBOX',
      uidValidity: '101', folderGeneration: '9', readRevision: 3, starRevision: 5,
    };
    let status = 'ready';
    query.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO inbox_rule_forwards')) return { rows: [] };
      if (sql.includes('SELECT status')) return { rows: [{
        id: 'delivery-1', status, recipient: input.recipient, payload_digest: digest,
        smtp_message: raw, smtp_envelope: envelope, source_snapshot: sourceSnapshot,
      }] };
      if (sql.includes('FROM messages')) throw new Error('prepared replay must not reload message content');
      if (sql.includes("SET status = 'provider_started'")) {
        status = 'provider_started';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'sent'")) {
        status = 'sent';
        return { rows: [{ id: 'delivery-1' }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(forwardRuleMessage(input)).resolves.toBe('sent');

    expect(transport.sendMail).toHaveBeenCalledWith({ raw, envelope });
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(imapManager.fetchMultipleAttachments).not.toHaveBeenCalled();
    expect(revalidateLiveMessageSnapshots).toHaveBeenCalledWith(account.id, [sourceSnapshot]);
    expect(status).toBe('sent');
  });

  it('rejects an edited rule recipient that collides with a prepared forward identity', async () => {
    const raw = Buffer.from('prepared rule forward');
    const envelope = { from: 'mailbox@example.com', to: ['old-recipient@example.com'] };
    query.mockImplementation(async sql => {
      if (sql.includes('INSERT INTO inbox_rule_forwards')) return { rows: [] };
      if (sql.includes('SELECT status')) return { rows: [{
        id: 'delivery-1', status: 'ready', recipient: 'old-recipient@example.com',
        payload_digest: 'a'.repeat(64), smtp_message: raw, smtp_envelope: envelope,
        source_snapshot: {
          id: messageRow.id, accountId: account.id, uid: 42, folder: 'INBOX',
          uidValidity: '101', folderGeneration: '9', readRevision: 3, starRevision: 5,
        },
      }] };
      if (sql.includes('FROM messages')) return { rows: [messageRow] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(forwardRuleMessage({
      ...input, recipient: 'edited-recipient@example.com',
    })).rejects.toThrow(/payload collision/i);

    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});
