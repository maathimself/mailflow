import sanitizeHtml from 'sanitize-html';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi;

// Plain text for text/plain MIME parts and stored body_text. sanitize-html strips the tags but
// re-escapes & < > in the remaining text, which would show up literally ("R&amp;D") in a plain
// part, so decode the entities it may leave behind. A single pass keeps "&amp;lt;" as "&lt;".
export function htmlToText(html) {
  const stripped = sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} });
  return stripped.replace(ENTITY_RE, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()];
    const codePoint = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    const valid = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : match;
  });
}
