// vCard 3.0 parser and generator (RFC 2426).
// Used by the contacts REST API and the CardDAV server.

// Sanitize a vCard parameter value (e.g. TYPE=...).
// Strips CR, LF, and other characters that are structural in vCard lines.
function escapeParam(str) {
  if (!str) return '';
  return str.replace(/[\r\n;:,]/g, '');
}

// Escape special characters in a vCard property value.
function escapeValue(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

// Unescape a vCard property value.
function unescapeValue(str) {
  if (!str) return '';
  return str
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Fold a vCard line at 75 octets per RFC 6350 §3.2.
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line + '\r\n';
  const parts = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const max = first ? 75 : 74; // continuation lines have a leading space
    // Walk back to a character boundary
    let end = offset + max;
    if (end >= bytes.length) {
      end = bytes.length;
    } else {
      // back off until we're at a UTF-8 character boundary
      while (end > offset && (bytes[end] & 0xC0) === 0x80) end--;
    }
    const chunk = bytes.slice(offset, end).toString('utf8');
    parts.push((first ? '' : ' ') + chunk);
    offset = end;
    first = false;
  }
  return parts.join('\r\n') + '\r\n';
}

// Unfold a raw vCard string — join lines that start with whitespace.
function unfold(raw) {
  return raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

/**
 * Parse a vCard 3.0 string and return a plain object with the fields
 * MailFlow cares about. Unknown properties are silently ignored.
 *
 * Returns: { uid, displayName, firstName, lastName, emails, phones, organization, notes, photoData }
 */
export function parseVCard(raw) {
  const text = unfold(raw || '');
  const result = {
    uid: null,
    displayName: null,
    firstName: null,
    lastName: null,
    emails: [],
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'BEGIN:VCARD' || trimmed === 'END:VCARD') continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;

    const rawName = trimmed.slice(0, colonIdx).toUpperCase();
    const value   = trimmed.slice(colonIdx + 1);

    // Strip parameters (e.g. "EMAIL;TYPE=WORK:..." → name = "EMAIL")
    const name = rawName.split(';')[0];
    const params = rawName.includes(';') ? rawName.slice(rawName.indexOf(';') + 1) : '';

    switch (name) {
      case 'VERSION': break; // ignore
      case 'UID':
        result.uid = unescapeValue(value).trim();
        break;
      case 'FN':
        result.displayName = unescapeValue(value).trim() || null;
        break;
      case 'N': {
        // N:Last;First;Additional;Prefix;Suffix
        const parts = value.split(';').map(p => unescapeValue(p).trim());
        result.lastName  = parts[0] || null;
        result.firstName = parts[1] || null;
        break;
      }
      case 'EMAIL': {
        const emailVal = unescapeValue(value).trim().toLowerCase();
        if (emailVal) {
          const typeMatch = params.match(/TYPE=([^;]+)/i);
          const type = typeMatch ? typeMatch[1].toLowerCase().replace(/["']/g, '') : 'other';
          const isPrimary = result.emails.length === 0;
          result.emails.push({ value: emailVal, type, primary: isPrimary });
        }
        break;
      }
      case 'TEL': {
        const phoneVal = unescapeValue(value).trim();
        if (phoneVal) {
          const typeMatch = params.match(/TYPE=([^;]+)/i);
          const type = typeMatch ? typeMatch[1].toLowerCase().replace(/["']/g, '') : 'other';
          result.phones.push({ value: phoneVal, type });
        }
        break;
      }
      case 'ORG':
        result.organization = unescapeValue(value.split(';')[0]).trim() || null;
        break;
      case 'NOTE':
        result.notes = unescapeValue(value).trim() || null;
        break;
      case 'PHOTO': {
        const v = value.trim();
        if (!v) break;
        if (v.startsWith('data:')) {
          // vCard 4.0 inline data URI — store as-is.
          result.photoData = v;
        } else if (/^https?:\/\//i.test(v)) {
          // External URL — skip to avoid privacy leak / fetch complexity.
          result.photoData = null;
        } else {
          // vCard 3.0 ENCODING=b raw base64 — derive MIME from TYPE param.
          const typeMatch = params.match(/TYPE=([^;]+)/i);
          const rawType = typeMatch ? typeMatch[1].replace(/["']/g, '').toUpperCase() : 'JPEG';
          const mimeMap = { JPEG: 'image/jpeg', JPG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', WEBP: 'image/webp' };
          const mimeType = mimeMap[rawType] || 'image/jpeg';
          result.photoData = `data:${mimeType};base64,${v}`;
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Generate a vCard 3.0 string from a contact object.
 *
 * contact: { uid, displayName, firstName, lastName, emails, phones, organization, notes }
 */
export function generateVCard(contact) {
  const {
    uid,
    displayName,
    firstName,
    lastName,
    emails = [],
    phones = [],
    organization,
    notes,
  } = contact;

  const lines = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');
  lines.push(`UID:${escapeValue(uid || '')}`);

  const fn = displayName
    || (firstName || lastName ? [firstName, lastName].filter(Boolean).join(' ') : null)
    || (emails[0]?.value ?? '');
  lines.push(`FN:${escapeValue(fn)}`);

  if (firstName || lastName) {
    lines.push(`N:${escapeValue(lastName || '')};${escapeValue(firstName || '')};;;`);
  }

  for (const e of emails) {
    const type = escapeParam((e.type || 'other').toUpperCase());
    lines.push(`EMAIL;TYPE=${type}:${escapeValue(e.value || '')}`);
  }

  for (const p of phones) {
    const type = escapeParam((p.type || 'voice').toUpperCase());
    lines.push(`TEL;TYPE=${type}:${escapeValue(p.value || '')}`);
  }

  if (organization) {
    lines.push(`ORG:${escapeValue(organization)}`);
  }

  if (notes) {
    lines.push(`NOTE:${escapeValue(notes)}`);
  }

  lines.push('END:VCARD');

  // Fold and join
  return lines.map(foldLine).join('');
}
