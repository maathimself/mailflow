import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';

// Keep email table presentation through editor parsing, draft saves and HTML mode.
const htmlAttribute = name => ({
  default: null,
  parseHTML: element => element.getAttribute(name),
  renderHTML: attrs => attrs[name] == null ? {} : { [name]: attrs[name] },
});

export const ComposerTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...Object.fromEntries(['style', 'width', 'align', 'border', 'cellpadding', 'cellspacing']
        .map(name => [name, htmlAttribute(name)])),
    };
  },
});

const cellAttributes = function () {
  return { ...this.parent?.(), style: htmlAttribute('style') };
};
export const ComposerTableCell = TableCell.extend({ addAttributes: cellAttributes });
export const ComposerTableHeader = TableHeader.extend({ addAttributes: cellAttributes });

export const TABLE_DEFAULTS = {
  rows: 3, cols: 3, padding: 2, spacing: 0, border: 1,
  alignment: '', width: 100, unit: '%', header: true,
};

// The form bounds also apply here so programmatic inserts cannot create huge tables.
const integer = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
};

export function createTableContent(options = {}) {
  const values = { ...TABLE_DEFAULTS, ...options };
  const rows = integer(values.rows, 1, 100, 3);
  const cols = integer(values.cols, 1, 50, 3);
  const padding = integer(values.padding, 0, 50, 2);
  const spacing = integer(values.spacing, 0, 50, 0);
  const border = integer(values.border, 0, 20, 1);
  const unit = values.unit === '%' ? '%' : 'px';
  const width = integer(values.width, 1, unit === '%' ? 100 : 2000, 100);
  const alignment = ['left', 'center', 'right'].includes(values.alignment) ? values.alignment : null;
  const margins = alignment === 'center' ? 'margin-left: auto; margin-right: auto;'
    : alignment === 'right' ? 'margin-left: auto; margin-right: 0;'
      : 'margin-left: 0; margin-right: auto;';
  return {
    type: 'table',
    attrs: {
      width: `${width}${unit === '%' ? '%' : ''}`, align: alignment,
      border: String(border), cellpadding: String(padding), cellspacing: String(spacing),
      style: `width: ${width}${unit}; max-width: 100%; border-collapse: ${spacing ? 'separate' : 'collapse'}; border-spacing: ${spacing}px; border: ${border}px solid #808080; ${margins}`,
    },
    content: Array.from({ length: rows }, (_, row) => ({
      type: 'tableRow',
      content: Array.from({ length: cols }, () => ({
        type: row === 0 && values.header ? 'tableHeader' : 'tableCell',
        attrs: { style: `padding: ${padding}px; border: ${border}px solid #808080; vertical-align: top;` },
        content: [{ type: 'paragraph' }],
      })),
    })),
  };
}
