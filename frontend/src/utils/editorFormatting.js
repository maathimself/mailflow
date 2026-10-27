import { Extension, Mark, mergeAttributes } from '@tiptap/core';

function scriptMark(name, tag, other) {
  return Mark.create({
    name,
    excludes: other,
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes(HTMLAttributes), 0],
    addCommands() {
      return { [`toggle${name[0].toUpperCase()}${name.slice(1)}`]: () => ({ commands }) => commands.toggleMark(name) };
    },
  });
}

export const Superscript = scriptMark('superscript', 'sup', 'subscript');
export const Subscript = scriptMark('subscript', 'sub', 'superscript');

export const ParagraphIndent = Extension.create({
  name: 'paragraphIndent',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indent: {
          default: 0,
          parseHTML: element => Math.max(0, Math.min(10, Math.round((parseFloat(element.style.marginLeft) || 0) / 40))),
          renderHTML: attrs => attrs.indent ? { style: `margin-left: ${attrs.indent * 40}px` } : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      changeIndent: direction => ({ editor, tr, dispatch, commands }) => {
        if (editor.isActive('listItem')) {
          return direction > 0 ? commands.sinkListItem('listItem') : commands.liftListItem('listItem');
        }
        let changed = false;
        tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, position) => {
          if (!['paragraph', 'heading'].includes(node.type.name)) return;
          const indent = Math.max(0, Math.min(10, (node.attrs.indent || 0) + direction));
          if (indent === node.attrs.indent) return;
          changed = true;
          if (dispatch) tr.setNodeMarkup(position, undefined, { ...node.attrs, indent });
        });
        return changed;
      },
    };
  },
});
