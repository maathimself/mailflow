import { DOMSerializer } from '@tiptap/pm/model';
import DOMPurify from 'dompurify';
import { copyToClipboard } from './clipboard.js';
import { withoutPageColors } from './pageColors.js';

export async function copyEditorSelection(editor, selection) {
  const { from, to } = selection;
  const text = editor.state.doc.textBetween(from, to, '\n');
  const clipboard = globalThis.navigator?.clipboard;
  const Item = globalThis.ClipboardItem;
  if (clipboard?.write && Item) {
    const wrapper = document.createElement('div');
    wrapper.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(editor.state.doc.slice(from, to).content));
    try {
      await clipboard.write([new Item({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([wrapper.innerHTML], { type: 'text/html' }),
      })]);
      return true;
    } catch { /* Plain-text copying also works on hosts without rich clipboard access. */ }
  }
  // A text-only fallback cannot safely cut an image or another non-text selection.
  return text ? (await copyToClipboard(text)).ok : false;
}

export async function readComposerClipboard(rich) {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.read) {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        if (rich && item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text();
          return { html: withoutPageColors(DOMPurify.sanitize(html), document) };
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) return { text: await (await item.getType('text/plain')).text() };
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (rich && imageType) return { image: await item.getType(imageType) };
      }
    } catch { /* Try readText when the browser only grants access to plain text. */ }
  }
  if (clipboard?.readText) {
    try { return { text: await clipboard.readText() }; } catch { /* Report failure to the caller. */ }
  }
  return null;
}

export function textParagraphs(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => ({
    type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
  }));
}
