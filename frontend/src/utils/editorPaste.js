import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// Text pasted from an email leaves behind the colors of the page it was shown on, and keeps the
// colors anyone chose wherever the copy still tells them apart from the page's.
//
// Chrome does not copy markup as written. It wraps each copied run in a span carrying the
// styles in effect where it sat, including the background of the nearest ancestor that has
// one. Out of an email shown as sent, that is the frame's white page and its #1a1a1a text:
//
//   <span style="color: rgb(26, 26, 26); ...; orphans: 2; ...; widows: 2; ...;
//     -webkit-text-stroke-width: 0px; ...; background-color: rgb(255, 255, 255); ...">
//
// and out of one recolored for the dark theme, its recolored text on the theme's page,
// rgb(228, 228, 232) on rgb(15, 15, 17). Kept as marks, the first is dark text in a white box on
// the dark theme, and the second hardly shows in the dark composer but reaches a recipient
// reading on white as a near-black box. Both go out with the message, and both swallow whatever
// is typed after them (the mark is inclusive). A copy that spans paragraphs puts that wrapper on
// the blocks and keeps each element inside with its own style, which in a recolored email is the
// recoloring's: every color it writes is !important, and the color of any text comes with
// -webkit-text-fill-color: currentcolor !important.
//
// So two kinds of color are dropped. On an element that carries Chrome's wrapper (orphans,
// widows and -webkit-text-stroke-width together), all of them: the text color goes with the
// background, because it was chosen for it. In a paste that carries the recoloring's marker
// anywhere, the recoloring's own: every color of an element with its marker, and an !important
// background on any element, since it rewrites every background but marks only elements with
// text of their own. A sender's text color that it left alone is kept, !important or not, and so
// are colors from Word, Google Docs or Firefox (which puts the markup on the clipboard as
// written) and the composer's own: ProseMirror writes its clipboard itself.

const PAGE_BOX = [/(?:^|;)\s*orphans\s*:/i, /(?:^|;)\s*widows\s*:/i, /(?:^|;)\s*-webkit-text-stroke-width\s*:/i];
const RECOLOR_MARK = /(?:^|;)\s*-webkit-text-fill-color\s*:[^;]*!\s*important/i;
const IMPORTANT = /!\s*important\s*$/i;
const BACKGROUND = /^\s*background(?:-color)?\s*:/i;
const COLOR_PROPERTIES = new Set(['color', 'background-color', 'background', '-webkit-text-fill-color']);

const isColor = declaration => COLOR_PROPERTIES.has(declaration.split(':')[0].trim().toLowerCase());

function withoutPageColors(html, doc) {
  // Neither marker anywhere: most pastes are handed on untouched.
  if (!/-webkit-text-(?:stroke-width|fill-color)\s*:/i.test(html)) return html;
  // A <template>: nothing in the paste loads or runs while it is cleaned.
  const template = doc.createElement('template');
  template.innerHTML = html;
  const styled = [...template.content.querySelectorAll('[style]')];
  const recolored = styled.some(element => RECOLOR_MARK.test(element.getAttribute('style')));
  let changed = false;
  for (const element of styled) {
    const style = element.getAttribute('style');
    const declarations = style.split(';');
    const pageBox = PAGE_BOX.every(property => property.test(style));
    const marked = RECOLOR_MARK.test(style);
    const recoloring = declaration => recolored
      && (marked || (IMPORTANT.test(declaration) && BACKGROUND.test(declaration)));
    const kept = declarations.filter(declaration => !isColor(declaration)
      || !(pageBox || recoloring(declaration)));
    if (kept.length === declarations.length) continue;
    const rest = kept.join(';');
    // An empty style attribute would still become an empty text style, and an empty <span>.
    if (rest.trim()) element.setAttribute('style', rest);
    else element.removeAttribute('style');
    changed = true;
  }
  return changed ? template.innerHTML : html;
}

export const PasteWithoutPageColors = Extension.create({
  name: 'pasteWithoutPageColors',

  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('pasteWithoutPageColors'),
      props: {
        // Before ProseMirror parses the HTML: the markers are in the style attributes, which
        // the parsed marks no longer carry.
        transformPastedHTML: (html, view) => withoutPageColors(html, view.dom.ownerDocument),
      },
    })];
  },
});
