import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { withoutPageColors } from './pageColors.js';

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
