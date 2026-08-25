import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseStoredJson(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function withoutCustomBccHeaders(headers) {
  if (Array.isArray(headers)) {
    return headers.filter(header => String(header?.key || '').toLowerCase() !== 'bcc');
  }
  if (headers && typeof headers === 'object') {
    return Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'bcc'),
    );
  }
  return headers;
}

function withoutBcc(mailOptions) {
  const deliveryOptions = { ...mailOptions };
  const headers = deliveryOptions.headers;
  delete deliveryOptions.bcc;
  delete deliveryOptions.headers;
  return {
    ...deliveryOptions,
    ...(headers === undefined ? {} : { headers: withoutCustomBccHeaders(headers) }),
  };
}

function hasTopLevelBccHeader(message) {
  const headerBlock = Buffer.from(message).toString('latin1').split(/\r?\n\r?\n/, 1)[0];
  return headerBlock.split(/\r?\n/).some(line => /^bcc[ \t]*:/i.test(line));
}

async function renderMessage(mailOptions, envelope, date) {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
  const info = await transport.sendMail({ ...mailOptions, date, envelope });
  const chunks = [];
  await new Promise((resolve, reject) => {
    info.message.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    info.message.on('end', resolve);
    info.message.on('error', reject);
  });
  return Buffer.concat(chunks);
}

export function preparedSmtpDigest(message, envelope) {
  return createHash('sha256')
    .update(Buffer.from(message))
    .update('\0')
    .update(stableJson(envelope))
    .digest('hex');
}

export async function renderPreparedSmtp(
  mailOptions,
  envelope,
  { includeBccInSentCopy = false } = {},
) {
  const date = mailOptions.date || new Date();
  const cleanHeaders = withoutCustomBccHeaders(mailOptions.headers);
  const message = await renderMessage(withoutBcc(mailOptions), envelope, date);
  if (hasTopLevelBccHeader(message)) {
    const error = new Error('Prepared SMTP delivery contains a Bcc header');
    error.code = 'SMTP_PREPARED_BCC_DISCLOSURE';
    error.retryable = false;
    throw error;
  }
  const sentMessage = includeBccInSentCopy
    ? await renderMessage({ ...mailOptions, headers: cleanHeaders }, envelope, date)
    : null;
  return {
    message,
    sentMessage,
    envelope,
    digest: preparedSmtpDigest(message, envelope),
  };
}

export function loadPreparedSmtp({ message, envelope, digest }) {
  const storedMessage = message == null ? null : Buffer.from(message);
  const storedEnvelope = parseStoredJson(envelope);
  if (!storedMessage?.length || !storedEnvelope || typeof digest !== 'string' ||
      preparedSmtpDigest(storedMessage, storedEnvelope) !== digest) {
    const error = new Error('Durable SMTP payload is incomplete or corrupt');
    error.code = 'SMTP_PREPARED_PAYLOAD_INVALID';
    error.retryable = false;
    throw error;
  }
  return { raw: storedMessage, envelope: storedEnvelope };
}
