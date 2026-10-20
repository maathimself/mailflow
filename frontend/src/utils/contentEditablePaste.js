import DOMPurify from 'dompurify';
import { withoutPageColors } from './pageColors.js';

// Paste into the composer's signature and quoted-reply areas, and the signature editor in
// Settings, without the colors of the page the text was copied from (pageColors.js).
//
// These are plain contenteditables, so a paste is the browser's own, and it keeps the inline
// colors the clipboard carries. Paragraphs copied out of an email arrive with the frame's white
// page and #1a1a1a text on every <p>: dark text in a white box on the dark theme, and a box the
// recipient gets too. So a paste that carries those colors is inserted by the page instead,
// without them, and any other paste is still the browser's own.
//
// The page inserts the HTML itself, so it is sanitized first, as the browser's paste would be,
// and <style> blocks are dropped because they would restyle the app around the editor. The ends
// are trimmed: on Windows the clipboard's HTML comes wrapped in <html> and <body> with line
// breaks, which would be inserted as spaces.
export function pasteWithoutPageColors(event) {
  const html = event.clipboardData?.getData('text/html');
  const cleaned = withoutPageColors(html, document);
  if (cleaned === html) return;
  const safe = DOMPurify.sanitize(cleaned, { FORBID_TAGS: ['style'] }).trim();
  if (!safe) return;
  const editor = event.currentTarget;
  const before = editor.innerHTML;
  // insertHTML keeps the paste on the undo stack and fires the input event the editors save
  // from. Chrome can report false for an insertion it has made, so the editor is checked too:
  // only if nothing was inserted does the browser's own paste go ahead, rather than lose the text.
  if (document.execCommand('insertHTML', false, safe) || editor.innerHTML !== before) event.preventDefault();
}
