import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { sanitizeComposeBody } from '../emailSanitizer.js';
import { sanitizeHeaderValue } from './addresses.js';

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textToHtml(text) {
  return '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    String(text || '').split('\n').map(l => `<p style="margin:0">${escapeHtml(l) || '&nbsp;'}</p>`).join('') +
    '</div>';
}

export function sigToPlainText(html) {
  return sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} }).trim();
}

export function bodyToPlain(body, isHtml) {
  if (!isHtml) return body || '';
  return sanitizeHtml(body || '', { allowedTags: [], allowedAttributes: {} });
}

export function bodyToHtml(body, isHtml) {
  if (!isHtml) return textToHtml(body || '');
  return sanitizeComposeBody(body || '');
}

function joinRecipients(recipients) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  return list.filter(Boolean).join(', ') || undefined;
}

export function buildMailOptions({
  messageId,
  fromName,
  fromEmail,
  replyTo,
  to,
  cc,
  bcc,
  subject,
  priority,
  text,
  html,
  inReplyTo,
  references,
  attachments,
}) {
  const mailOptions = {
    messageId,
    from: `${fromName} <${fromEmail}>`,
    ...(replyTo ? { replyTo } : {}),
    to: joinRecipients(to),
    cc: joinRecipients(cc),
    bcc: joinRecipients(bcc),
    subject: sanitizeHeaderValue(subject || ''),
    ...(priority && priority !== 'normal' ? { priority } : {}),
    text,
    ...(html !== undefined ? { html } : {}),
  };

  if (inReplyTo) {
    mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
    mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
  } else if (references) {
    mailOptions.references = sanitizeHeaderValue(references);
  }
  if (attachments?.length) mailOptions.attachments = attachments;
  return mailOptions;
}

export async function renderRaw(mailOptions) {
  const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
  const streamInfo = await streamTransport.sendMail(mailOptions);
  const chunks = [];
  await new Promise((resolve, reject) => {
    streamInfo.message.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    streamInfo.message.on('end', resolve);
    streamInfo.message.on('error', reject);
  });
  return Buffer.concat(chunks);
}
