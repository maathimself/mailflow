import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';

// Pasted text takes the composer's colours, not those of the page it was copied from.
//
// Chrome does not copy markup as written. It wraps each copied run in a span carrying the
// styles in effect where it sat, including the background of the nearest ancestor that has
// one. Out of an email shown as sent, that is the frame's white page and its #1a1a1a text:
//
//   <span style="color: rgb(26, 26, 26); ...; background-color: rgb(255, 255, 255); ...">
//
// and out of one recoloured for the dark theme, its recoloured text on the theme's page,
// rgb(228, 228, 232) on rgb(15, 15, 17). Kept as marks, the first is dark text in a white box
// on the dark theme, and the second hardly shows in the dark composer but reaches a recipient
// reading on white as a near-black box. Both go out with the message, and both swallow
// whatever is typed after them (the mark is inclusive). A copy that spans paragraphs puts the
// page's colours on the blocks, which the composer drops, and keeps each element's own colours
// apart from them; from a recoloured email, those are the recolouring's.
//
// The text colour has to go with the background: #1a1a1a is unreadable on the dark composer
// once the white is gone, and white text from a dark newsletter is invisible to a recipient
// reading on white. Nor can a highlight be told apart from the page behind it: within a
// paragraph the browser writes both as a background-color among the styles in effect, so the
// highlighted words of a copied line carry rgb(255, 255, 0) as the words around them carry the
// page's white. So colours from another page or document do not survive a paste. Bold, links,
// fonts and sizes do, and the toolbar can put colours back.
//
// Left alone: HTML that ProseMirror itself put on the clipboard (data-pm-slice), which is text
// cut or copied in a composer and carries colours the user applied; plain-text pastes, which
// take the marks around the caret as typing does; and text dragged within the editor.

const COLOR_ATTRS = ['color', 'backgroundColor'];

function withoutColors(marks, textStyle) {
  return marks.flatMap(mark => {
    if (mark.type !== textStyle || !COLOR_ATTRS.some(name => mark.attrs[name])) return [mark];
    const attrs = { ...mark.attrs };
    for (const name of COLOR_ATTRS) attrs[name] = null;
    // A span that only carried colours has nothing left worth keeping.
    return Object.values(attrs).some(Boolean) ? [textStyle.create(attrs)] : [];
  });
}

function stripColors(fragment, textStyle) {
  const nodes = [];
  fragment.forEach(node => {
    const marks = withoutColors(node.marks, textStyle);
    nodes.push(node.isText ? node.mark(marks) : node.copy(stripColors(node.content, textStyle)).mark(marks));
  });
  return Fragment.fromArray(nodes);
}

export const PasteWithoutSourceColors = Extension.create({
  name: 'pasteWithoutSourceColors',

  addProseMirrorPlugins() {
    // Set by transformPastedHTML, which ProseMirror calls for an HTML paste or drop just
    // before handing transformPasted the slice it parsed from that same HTML.
    let copiedInEditor = false;
    return [new Plugin({
      key: new PluginKey('pasteWithoutSourceColors'),
      props: {
        transformPastedHTML(html) {
          copiedInEditor = /<[a-z][^>]*\sdata-pm-slice=/i.test(html);
          return html;
        },
        transformPasted(slice, view, plain) {
          const keep = plain || copiedInEditor || view.dragging;
          copiedInEditor = false;
          const textStyle = view.state.schema.marks.textStyle;
          if (keep || !textStyle) return slice;
          return new Slice(stripColors(slice.content, textStyle), slice.openStart, slice.openEnd);
        },
      },
    })];
  },
});
