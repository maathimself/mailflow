// Regex matching zero-width and invisible Unicode chars that corrupt preview snippets:
// U+00AD soft-hyphen, U+200B zero-width space, U+200C ZWNJ, U+200D ZWJ,
// U+200E LTR mark, U+200F RTL mark, U+FEFF BOM / zero-width no-break space.
const INVISIBLE_CHARS_RE = new RegExp(
  [0x00AD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0xFEFF]
    .map(n => String.fromCodePoint(n)).join('|'),
  'g'
);

// Walk bodyStructure to find the best text part for a snippet.
// Prefers text/plain; falls back to text/html.
function findSnippetPart(structure) {
  if (!structure) return null;
  const type = (structure.type || '').toLowerCase();

  if (structure.childNodes?.length) {
    let htmlFallback = null;
    for (const child of structure.childNodes) {
      const found = findSnippetPart(child);
      if (!found) continue;
      if (found.type === 'text/plain') return found;
      if (!htmlFallback) htmlFallback = found;
    }
    return htmlFallback;
  }

  const disposition = (structure.disposition || '').toLowerCase();
  if (disposition === 'attachment') return null;

  if (type === 'text/plain' || type === 'text/html') {
    return {
      part: structure.part || '1',
      type,
      encoding: (structure.encoding || '').toLowerCase(),
      charset: structure.parameters?.charset || 'utf-8',
    };
  }
  return null;
}

// Decode a body part Buffer using the given transfer encoding and charset.
// Mirrors the same function in imapManager.js — kept local to avoid a
// circular import (messageParser is imported by imapManager).
function decodeBodyPart(buf, encoding, charset) {
  const enc = (encoding || '').toLowerCase();
  let cs = (charset || 'utf-8').toLowerCase().trim().replace(/^['"]|['"]$/g, '');
  if (!cs || cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8';

  let rawBytes;
  if (enc === 'base64') {
    const b64 = buf.toString('ascii').replace(/\s/g, '');
    try { rawBytes = Buffer.from(b64, 'base64'); } catch (_) { rawBytes = buf; }
  } else if (enc === 'quoted-printable') {
    const cleaned = buf.toString('ascii').replace(/=\r\n/g, '').replace(/=\n/g, '');
    const bytes = [];
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length) {
        const hex = cleaned.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      bytes.push(cleaned.charCodeAt(i) & 0xFF);
      i++;
    }
    rawBytes = Buffer.from(bytes);
  } else {
    rawBytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  try {
    return new TextDecoder(cs, { fatal: false }).decode(rawBytes);
  } catch (_) {
    return rawBytes.toString('utf8');
  }
}

export async function parseMessage(msg) {
  const envelope = msg.envelope || {};
  const flags = msg.flags ? [...msg.flags] : [];

  const fromAddr = envelope.from?.[0] || {};
  // imapflow returns { name, address } — older typedefs showed mailbox+host but
  // that's not what the library actually emits. Fall back to the legacy form too.
  const fromEmail = fromAddr.address
    || (fromAddr.mailbox && fromAddr.host ? `${fromAddr.mailbox}@${fromAddr.host}` : '');
  const fromName = fromAddr.name || fromAddr.mailbox || fromEmail.split('@')[0] || '';

  const mapAddrs = (addrs) => (addrs || []).map(a => ({
    name: a.name || '',
    email: a.address || (a.mailbox && a.host ? `${a.mailbox}@${a.host}` : ''),
  }));

  const isRead = flags.includes('\\Seen');
  const isStarred = flags.includes('\\Flagged');

  // Build snippet from the first available text body part, properly decoded.
  let snippet = '';
  if (msg.bodyParts && msg.bodyParts.size > 0) {
    // Try to identify the correct part and its encoding from bodyStructure
    const partInfo = msg.bodyStructure ? findSnippetPart(msg.bodyStructure) : null;

    let rawBuf = null;
    let encoding = '';
    let charset = 'utf-8';
    let isHtml = false;

    if (partInfo && msg.bodyParts.has(partInfo.part)) {
      rawBuf = msg.bodyParts.get(partInfo.part);
      encoding = partInfo.encoding;
      charset = partInfo.charset || 'utf-8';
      isHtml = partInfo.type === 'text/html';
    } else {
      // Fallback: grab the first available part (may be wrong for multipart)
      for (const [, value] of msg.bodyParts) {
        rawBuf = value;
        break;
      }
    }

    if (rawBuf) {
      try {
        let text = decodeBodyPart(rawBuf, encoding, charset);

        if (isHtml) {
          text = text
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'")
            .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
            // Catch-all: any remaining named HTML entities (&zwnj; &shy; &hellip; etc.)
            .replace(/&[a-z][a-z0-9]*;/gi, ' ');
        }

        // Entity catch-all also covers plain-text parts whose senders embed HTML
        // entities (e.g. &zwnj;) directly in a text/plain body.
        snippet = text
          .replace(/&[a-z][a-z0-9]*;/gi, ' ')
          .replace(INVISIBLE_CHARS_RE, '')
          .replace(/\s+/g, ' ').trim().substring(0, 200);
      } catch (_) {}
    }
  }

  // Detect attachments from body structure
  let hasAttachments = false;
  if (msg.bodyStructure) {
    hasAttachments = detectAttachments(msg.bodyStructure);
  }

  return {
    uid: msg.uid,
    messageId: envelope.messageId || null,
    subject: envelope.subject || '(no subject)',
    fromName,
    fromEmail,
    to: mapAddrs(envelope.to),
    cc: mapAddrs(envelope.cc),
    replyTo: mapAddrs(envelope.replyTo),
    inReplyTo: envelope.inReplyTo || null,
    date: msg.internalDate || envelope.date || new Date(),
    snippet,
    isRead,
    isStarred,
    hasAttachments,
    flags,
  };
}

function detectAttachments(structure) {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some(child => detectAttachments(child));
  }
  return false;
}
