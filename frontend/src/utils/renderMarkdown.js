import { marked } from 'marked';
import DOMPurify from 'dompurify';

// AI operation outputs are markdown; render them to sanitized HTML for display (#215).
// The text is model-generated and can be steered by email content (prompt injection),
// so it is treated as UNTRUSTED: the parsed HTML always goes through DOMPurify with a
// tight tag/attribute allow-list, and any raw HTML the model emits is neutralised.
marked.setOptions({
  gfm: true,     // tables, strikethrough, autolinks
  breaks: true,  // single newlines -> <br>, so plain-text (non-markdown) output keeps its line breaks
});

// Tags a markdown document can legitimately produce. Deliberately excludes <img>,
// <script>, <style>, <iframe>, and form elements.
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

// Force links to open in a new tab without leaking the opener. Registered per call and
// removed immediately in finally so it never affects other DOMPurify sanitizes (e.g. the
// email renderer, which uses inline options and no hooks).
function hardenLinks(node) {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}

export function renderMarkdown(text) {
  const html = marked.parse(text || '', { async: false });
  DOMPurify.addHook('afterSanitizeAttributes', hardenLinks);
  try {
    // DOMPurify blocks javascript:/unsafe URLs in href by default; the tag allow-list
    // (no <img>/<svg>) removes the usual data:-URI vectors.
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}
