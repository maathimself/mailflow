import { embedInlineDataImages } from '../utils/inlineImages.js';
import { query } from './db.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { loadPreparedSmtp, renderPreparedSmtp } from './preparedSmtp.js';
import {
  revalidateLiveMessageSnapshots,
  snapshotFromMessageRow,
} from './messageSnapshots.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseAddresses(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatAddress(address) {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return '';

  const email = address.address || address.email || '';
  return address.name ? `${address.name} <${email}>` : email;
}

function formatAddresses(value) {
  return parseAddresses(value).map(formatAddress).filter(Boolean).join(', ');
}

function formatUtcDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toUTCString();
}

function forwardSubject(value) {
  const subject = String(value ?? '');
  return /^Fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function htmlToPlainText(value) {
  const namedEntities = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:blockquote|div|h[1-6]|li|p|pre|tr)\s*>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&#([0-9]+);/g, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&([a-z]+);/gi, (_, name) =>
      namedEntities.get(name.toLowerCase()) ?? ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttachments(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStoredJson(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function forwardedHeaders(row) {
  const from = formatAddress({
    name: row.from_name,
    address: row.from_email,
  });
  return [
    ['From', from],
    ['Date', formatUtcDate(row.date)],
    ['Subject', row.subject || ''],
    ['To', formatAddresses(row.to_addresses)],
    ['Cc', formatAddresses(row.cc_addresses)],
  ].filter(([, value]) => value);
}

export function buildForwardMessage({
  row,
  account,
  recipient,
  text,
  html,
  attachments = [],
}) {
  const headers = forwardedHeaders(row);
  const forwardHeaderText = [
    '---------- Forwarded message ----------',
    ...headers.map(([label, value]) => `${label}: ${value}`),
  ].join('\n');
  const forwardHeaderHtml = [
    '<div>---------- Forwarded message ----------<br>',
    ...headers.map(([label, value]) =>
      `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}<br>`),
    '</div><br>',
  ].join('');
  const safeHtml = html ? sanitizeEmail(html) : html;
  const plainBody = text || htmlToPlainText(safeHtml);

  return {
    from: `${account.sender_name || account.name} <${account.email_address}>`,
    to: recipient,
    subject: forwardSubject(row.subject),
    text: `${forwardHeaderText}\n\n${plainBody}`,
    ...(safeHtml ? { html: `${forwardHeaderHtml}${safeHtml}` } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

function ensureAttachmentLimit(attachments) {
  const totalBytes = attachments.reduce(
    (sum, attachment) => sum + (attachment.content?.length || 0),
    0
  );
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('Total attachment size exceeds 25 MB');
  }
}

async function loadForwardContent({ row, account, imapManager }) {
  const snapshot = snapshotFromMessageRow(row);
  let text = row.body_text;
  let html = row.body_html;
  let fetchedParts = [];
  if (!text && !html) {
    const fetched = await imapManager.fetchMessageBody(
      account,
      row.uid,
      row.folder,
      { snapshot },
    );
    text = fetched.text;
    html = fetched.html;
    fetchedParts = parseAttachments(fetched.attachments);
  }

  const storedParts = [];
  const seenParts = new Set();
  for (const attachment of [
    ...parseAttachments(row.attachments),
    ...fetchedParts,
  ]) {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      attachment.part === undefined ||
      attachment.part === null
    ) {
      continue;
    }
    const partKey = String(attachment.part);
    if (seenParts.has(partKey)) continue;
    seenParts.add(partKey);
    storedParts.push(attachment);
  }
  const knownBytes = storedParts.reduce(
    (sum, attachment) =>
      sum + (Number.isFinite(Number(attachment.size))
        ? Number(attachment.size)
        : 0),
    0
  );
  if (knownBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error('Total attachment size exceeds 25 MB');
  }

  let fetchedAttachments = [];
  if (storedParts.length) {
    const buffers = await imapManager.fetchMultipleAttachments(
      account,
      row.uid,
      row.folder,
      storedParts,
      { snapshot },
    );
    fetchedAttachments = storedParts.map(attachment => {
      const content = buffers.get(attachment.part);
      if (!content) {
        throw new Error('Forward attachment unavailable');
      }
      return {
        filename: attachment.filename || 'attachment',
        content,
        contentType: attachment.type || 'application/octet-stream',
      };
    });
  }

  const safeHtml = html ? sanitizeEmail(html) : html;
  const embedded = embedInlineDataImages(safeHtml);
  const attachments = [
    ...embedded.attachments,
    ...fetchedAttachments,
  ];
  ensureAttachmentLimit(attachments);

  return {
    text,
    html: embedded.html,
    attachments,
  };
}

export async function forwardRuleMessage({
  ruleId,
  message,
  account,
  imapManager,
  recipient,
}) {
  const reserved = await query(
    `INSERT INTO inbox_rule_forwards (rule_id, message_id, recipient)
     VALUES ($1, $2, $3)
     ON CONFLICT (rule_id, message_id) DO NOTHING
     RETURNING id, status, recipient, payload_digest, smtp_message, smtp_envelope,
               source_snapshot`,
    [ruleId, message.id, recipient]
  );
  let reservation = reserved.rows[0] ? {
    status: 'ready', recipient, ...reserved.rows[0],
  } : null;
  if (!reservation) {
    const existing = await query(
      `SELECT status, id, recipient, payload_digest, smtp_message, smtp_envelope,
              source_snapshot
       FROM inbox_rule_forwards
       WHERE rule_id = $1 AND message_id = $2`,
      [ruleId, message.id]
    );
    if (existing.rows[0]?.status === 'sent') return 'duplicate';
    if (['pending', 'provider_started', 'uncertain'].includes(existing.rows[0]?.status)) {
      throw new Error('Forward delivery outcome is uncertain');
    }
    if (existing.rows[0]?.status !== 'ready' || !existing.rows[0]?.id) {
      throw new Error('Forward delivery pending');
    }
    reservation = existing.rows[0];
  }
  const reservationId = reservation.id;
  if (reservation.recipient && reservation.recipient !== recipient) {
    throw new Error('Forward operation payload collision');
  }

  let deliveryStarted = false;
  let deliveryCompleted = false;
  let preparedDurably = Boolean(reservation.smtp_message);
  try {
    if (!preparedDurably) {
      const rowResult = await query(
        `SELECT m.id, m.account_id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
                m.to_addresses, m.cc_addresses, m.date, m.body_text, m.body_html, m.attachments,
                m.read_revision, m.star_revision,
                live_folder.uid_validity AS folder_uid_validity,
                live_folder.observation_generation AS folder_observation_generation
         FROM messages m
         JOIN folders live_folder ON live_folder.account_id = m.account_id
           AND live_folder.path = m.folder AND live_folder.is_present = true
           AND live_folder.uid_validity IS NOT NULL
         WHERE m.id = $1 AND m.account_id = $2
           AND m.is_deleted = false AND m.metadata_complete = true`,
        [message.id, account.id]
      );
      if (!rowResult.rows.length) {
        throw new Error('Forward source message not found');
      }
      const row = rowResult.rows[0];
      const sourceSnapshot = snapshotFromMessageRow(row);
      const content = await loadForwardContent({ row, account, imapManager });
      await revalidateLiveMessageSnapshots(account.id, [sourceSnapshot]);
      const prepared = await renderPreparedSmtp(
        buildForwardMessage({ row, account, recipient, ...content }),
        { from: account.email_address, to: [recipient] },
      );
      const stored = await query(
        `UPDATE inbox_rule_forwards
            SET recipient = $2, payload_digest = $3, smtp_message = $4,
                smtp_envelope = $5::jsonb, source_snapshot = $6::jsonb,
                prepared_at = NOW()
          WHERE id = $1 AND status = 'ready' AND smtp_message IS NULL
            AND (recipient IS NULL OR recipient = $2)
          RETURNING id, status, recipient, payload_digest, smtp_message, smtp_envelope,
                    source_snapshot`,
        [
          reservationId, recipient, prepared.digest, prepared.message,
          JSON.stringify(prepared.envelope), JSON.stringify(sourceSnapshot),
        ],
      );
      if (stored?.rowCount === 0) {
        const replay = await query(
          `SELECT status, id, recipient, payload_digest, smtp_message, smtp_envelope,
                  source_snapshot
             FROM inbox_rule_forwards
            WHERE id = $1`,
          [reservationId],
        );
        reservation = replay.rows[0];
      } else {
        reservation = stored?.rows?.[0]?.smtp_message ? stored.rows[0] : {
          ...reservation, recipient, payload_digest: prepared.digest,
          smtp_message: prepared.message, smtp_envelope: prepared.envelope,
          source_snapshot: sourceSnapshot,
        };
      }
      preparedDurably = Boolean(reservation?.smtp_message);
    }

    if (!preparedDurably || reservation.recipient !== recipient) {
      throw new Error('Forward operation payload collision');
    }
    const sourceSnapshot = parseStoredJson(reservation.source_snapshot);
    if (!sourceSnapshot?.id || sourceSnapshot.accountId !== account.id) {
      throw new Error('Durable forward source snapshot is unavailable');
    }
    const preparedMail = loadPreparedSmtp({
      message: reservation.smtp_message,
      envelope: reservation.smtp_envelope,
      digest: reservation.payload_digest,
    });

    const smtp = await createAccountSmtpTransport(account);
    if (smtp.error) throw new Error(smtp.error);
    if (!smtp.transport) throw new Error('SMTP transport is unavailable');

    await revalidateLiveMessageSnapshots(account.id, [sourceSnapshot]);

    try {
      const started = await query(
        `UPDATE inbox_rule_forwards
            SET status = 'provider_started'
          WHERE id = $1 AND status = 'ready' AND payload_digest = $2
          RETURNING id`,
        [reservationId, reservation.payload_digest],
      );
      if (started?.rowCount === 0) throw new Error('Forward delivery could not claim provider start');
      deliveryStarted = true;
      await smtp.transport.sendMail(preparedMail);
    } catch {
      throw new Error('Forward delivery failed');
    }
    const completed = await query(
      `UPDATE inbox_rule_forwards
       SET status = 'sent', recipient = NULL, smtp_message = NULL,
           smtp_envelope = NULL, source_snapshot = NULL, sent_at = NOW()
       WHERE id = $1 AND status = 'provider_started' AND payload_digest = $2
       RETURNING id`,
      [reservationId, reservation.payload_digest]
    );
    if (completed?.rowCount === 0) throw new Error('Forward delivery completion was not persisted');
    deliveryCompleted = true;
    await revalidateLiveMessageSnapshots(account.id, [sourceSnapshot]);
    return 'sent';
  } catch (err) {
    if (!deliveryStarted) {
      if (!preparedDurably) {
        try {
          await query(
            `DELETE FROM inbox_rule_forwards
             WHERE id = $1 AND status = 'ready' AND smtp_message IS NULL`,
            [reservationId]
          );
        } catch { /* retain the failed reservation */ }
      }
    } else if (!deliveryCompleted) {
      try {
        await query(
          `UPDATE inbox_rule_forwards SET status = 'uncertain'
            WHERE id = $1 AND status = 'provider_started'`,
          [reservationId],
        );
      } catch { /* provider_started remains a durable conservative block */ }
    }
    throw err;
  }
}
