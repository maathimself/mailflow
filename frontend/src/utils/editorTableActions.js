import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap, isInTable, selectedRect, addColumn, removeColumn, addRow, removeRow, deleteRow, deleteColumn, deleteTable } from '@tiptap/pm/tables';
import { createTableContent, TABLE_DEFAULTS } from './editorTable.js';

const styleOf = node => {
  const element = document.createElement('td');
  element.style.cssText = node.attrs.style || '';
  return element.style;
};

export const deleteTablePart = part => (state, dispatch) => {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const whole = part === 'rows' ? rect.top === 0 && rect.bottom === rect.map.height
    : rect.left === 0 && rect.right === rect.map.width;
  return whole ? deleteTable(state, dispatch) : (part === 'rows' ? deleteRow : deleteColumn)(state, dispatch);
};

function cellsOf(table) {
  const map = TableMap.get(table);
  return [...new Set(map.map)].map(offset => ({ node: table.nodeAt(offset), offset, ...map.findCell(offset) }));
}

export function selectedTableCells(state) {
  if (!isInTable(state)) return [];
  const rect = selectedRect(state);
  const selected = new Set(state.selection instanceof CellSelection
    ? rect.map.cellsInRect(rect) : [rect.map.map[rect.top * rect.map.width + rect.left]]);
  return cellsOf(rect.table).filter(cell => selected.has(cell.offset))
    .map(cell => ({ ...cell, pos: rect.tableStart + cell.offset }));
}

export const shadeTableCells = color => (state, dispatch) => {
  const cells = selectedTableCells(state);
  if (!cells.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const cell of cells) {
      const style = styleOf(cell.node);
      if (color) style.backgroundColor = color;
      else { style.removeProperty('background'); style.removeProperty('background-color'); }
      tr.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, style: style.cssText });
    }
    dispatch(tr);
  }
  return true;
};

export const alignTableCells = (vertical, horizontal) => (state, dispatch) => {
  const cells = selectedTableCells(state);
  if (!cells.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const cell of cells) {
      const style = styleOf(cell.node);
      style.verticalAlign = vertical; style.textAlign = horizontal;
      tr.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, style: style.cssText });
      // Explicit paragraph alignment would otherwise override the cell's alignment.
      cell.node.descendants((node, offset) => {
        if (['paragraph', 'heading'].includes(node.type.name)) {
          tr.setNodeMarkup(cell.pos + 1 + offset, undefined, { ...node.attrs, textAlign: horizontal });
        }
        return node.type.spec.tableRole === 'table' ? false : undefined;
      });
    }
    dispatch(tr);
  }
  return true;
};

export const setTableBorders = preset => (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  const rect = selectedRect(state);
  const cells = cellsOf(rect.table);
  const selected = new Set(selectedTableCells(state).map(cell => cell.offset));
  const styles = new Map(cells.map(cell => {
    const style = styleOf(cell.node);
    if (!style.border && !['Top', 'Bottom', 'Left', 'Right'].some(side => style[`border${side}Width`])) {
      style.border = `${Number(rect.table.attrs.border ?? 1)}px solid #808080`;
    }
    return [cell.offset, style];
  }));
  const edge = (cell, side) => ({ Top: cell.top === rect.top, Bottom: cell.bottom === rect.bottom,
    Left: cell.left === rect.left, Right: cell.right === rect.right })[side];
  const sideNames = ['Top', 'Bottom', 'Left', 'Right'];
  const single = sideNames.includes(preset);
  const turnOn = !single || !cells.filter(cell => selected.has(cell.offset) && edge(cell, preset))
    .every(cell => parseFloat(styles.get(cell.offset)[`border${preset}Width`]) > 0);
  const changes = [];
  for (const cell of cells) {
    if (!selected.has(cell.offset)) continue;
    for (const side of sideNames) {
      if (single && (side !== preset || !edge(cell, side))) continue;
      const visible = single ? turnOn : preset === 'all' || (preset === 'outside' && edge(cell, side)) || (preset === 'inside' && !edge(cell, side));
      const border = `${visible ? 1 : 0}px solid #808080`;
      changes.push({ cell, side, border });
    }
  }
  for (const { cell, side, border } of changes) {
    styles.get(cell.offset)[`border${side}`] = border;
    // In collapsed tables either side can draw a shared border. Update its neighbour too.
    const neighbours = new Set();
    const { width, height, map } = rect.map;
    if (side === 'Top' && cell.top > 0) for (let col = cell.left; col < cell.right; col++) neighbours.add(map[(cell.top - 1) * width + col]);
    if (side === 'Bottom' && cell.bottom < height) for (let col = cell.left; col < cell.right; col++) neighbours.add(map[cell.bottom * width + col]);
    if (side === 'Left' && cell.left > 0) for (let row = cell.top; row < cell.bottom; row++) neighbours.add(map[row * width + cell.left - 1]);
    if (side === 'Right' && cell.right < width) for (let row = cell.top; row < cell.bottom; row++) neighbours.add(map[row * width + cell.right]);
    const opposite = { Top: 'Bottom', Bottom: 'Top', Left: 'Right', Right: 'Left' }[side];
    for (const offset of neighbours) styles.get(offset)[`border${opposite}`] = border;
  }
  const tr = state.tr;
  for (const cell of cells) tr.setNodeMarkup(rect.tableStart + cell.offset, undefined, { ...cell.node.attrs, style: styles.get(cell.offset).cssText });
  const tableStyle = styleOf(rect.table);
  tableStyle.border = '0px solid #808080';
  tr.setNodeMarkup(rect.tableStart - 1, undefined, { ...rect.table.attrs, border: '0', style: tableStyle.cssText });
  dispatch(tr);
  return true;
};

function buildTable(table, cells, rowAttrs) {
  const schema = table.type.schema;
  const rows = rowAttrs.map((attrs, row) => schema.nodes.tableRow.create(attrs,
    cells.filter(cell => cell.top === row).sort((a, b) => a.left - b.left).map(cell => cell.node)));
  return table.copy(Fragment.fromArray(rows));
}

const withSpans = (node, rowspan, colspan, content = node.content, colwidth = node.attrs.colwidth) => node.type.create(
  { ...node.attrs, rowspan, colspan, colwidth }, content,
);

export const splitTableCell = direction => (state, dispatch) => {
  const selected = selectedTableCells(state);
  if (selected.length !== 1) return false;
  if (!dispatch) return true;
  const rect = selectedRect(state);
  const cells = cellsOf(rect.table);
  const target = cells.find(cell => cell.offset === selected[0].offset);
  const horizontal = direction === 'horizontal';
  const span = horizontal ? target.node.attrs.rowspan : target.node.attrs.colspan;
  const firstSpan = span > 1 ? Math.floor(span / 2) : 1;
  const secondSpan = span > 1 ? span - firstSpan : 1;
  const rowAttrs = Array.from({ length: rect.table.childCount }, (_, row) => rect.table.child(row).attrs);
  if (span === 1) {
    if (horizontal) rowAttrs.splice(target.top + 1, 0, rowAttrs[target.top]);
    for (const cell of cells) {
      if (cell === target) continue;
      if (horizontal) {
        if (cell.top > target.top) { cell.top++; cell.bottom++; }
        else if (cell.bottom > target.top) { cell.bottom++; cell.node = withSpans(cell.node, cell.node.attrs.rowspan + 1, cell.node.attrs.colspan); }
      } else {
        if (cell.left > target.left) { cell.left++; cell.right++; }
        else if (cell.right > target.left) {
          cell.right++;
          const widths = cell.node.attrs.colwidth?.slice() ?? null;
          if (widths) {
            const index = target.left - cell.left;
            const half = Math.max(1, Math.floor(widths[index] / 2));
            widths.splice(index, 1, half, Math.max(1, widths[index] - half));
          }
          cell.node = withSpans(cell.node, cell.node.attrs.rowspan, cell.node.attrs.colspan + 1, cell.node.content, widths);
        }
      }
    }
  }
  const empty = target.node.type.createAndFill().content;
  const original = target.node;
  let firstWidths = original.attrs.colwidth;
  let secondWidths = firstWidths;
  if (!horizontal && firstWidths) {
    if (span === 1) {
      const half = Math.max(1, Math.floor(firstWidths[0] / 2));
      secondWidths = [Math.max(1, firstWidths[0] - half)]; firstWidths = [half];
    } else { secondWidths = firstWidths.slice(firstSpan); firstWidths = firstWidths.slice(0, firstSpan); }
  }
  target.node = withSpans(original, horizontal ? firstSpan : original.attrs.rowspan,
    horizontal ? original.attrs.colspan : firstSpan, original.content, firstWidths);
  const second = { ...target, top: target.top + (horizontal ? firstSpan : 0), left: target.left + (horizontal ? 0 : firstSpan),
    node: withSpans(original, horizontal ? secondSpan : original.attrs.rowspan,
      horizontal ? original.attrs.colspan : secondSpan, empty, secondWidths) };
  const table = buildTable(rect.table, [...cells, second], rowAttrs);
  const tr = state.tr.replaceWith(rect.tableStart - 1, rect.tableStart - 1 + rect.table.nodeSize, table);
  const cellOffset = TableMap.get(table).map[target.top * TableMap.get(table).width + target.left];
  tr.setSelection(TextSelection.near(tr.doc.resolve(rect.tableStart + cellOffset + 1)));
  dispatch(tr);
  return true;
};

export function splitTable(state, dispatch) {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const boundary = rect.top;
  if (boundary === 0) return false;
  if (!dispatch) return true;
  const before = [], after = [];
  for (const cell of cellsOf(rect.table)) {
    if (cell.top < boundary) {
      before.push({ ...cell, node: withSpans(cell.node, Math.min(cell.bottom, boundary) - cell.top, cell.node.attrs.colspan) });
      if (cell.bottom > boundary) after.push({ ...cell, top: 0,
        node: withSpans(cell.node, cell.bottom - boundary, cell.node.attrs.colspan, cell.node.type.createAndFill().content) });
    } else after.push({ ...cell, top: cell.top - boundary });
  }
  const attrs = Array.from({ length: rect.table.childCount }, (_, row) => rect.table.child(row).attrs);
  const first = buildTable(rect.table, before, attrs.slice(0, boundary));
  const second = buildTable(rect.table, after, attrs.slice(boundary));
  const paragraph = state.schema.nodes.paragraph.create();
  const tr = state.tr.replaceWith(rect.tableStart - 1, rect.tableStart - 1 + rect.table.nodeSize, [first, paragraph, second]);
  tr.setSelection(TextSelection.near(tr.doc.resolve(rect.tableStart - 1 + first.nodeSize + paragraph.nodeSize + 3)));
  dispatch(tr.scrollIntoView());
  return true;
}

export function tableOptions(state) {
  if (!isInTable(state)) return TABLE_DEFAULTS;
  const { table, map } = selectedRect(state);
  const style = styleOf(table);
  const width = style.width || table.attrs.width || '100%';
  return {
    rows: map.height, cols: map.width,
    padding: Number(table.attrs.cellpadding ?? 2), spacing: Number(table.attrs.cellspacing ?? 0),
    border: Number(table.attrs.border ?? 1), alignment: table.attrs.align || '',
    width: parseInt(width, 10) || 100, unit: width.includes('%') ? '%' : 'px',
    header: table.firstChild.childCount > 0 && table.firstChild.content.content.every(cell => cell.type.name === 'tableHeader'),
  };
}

export const updateTableProperties = options => (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  const original = selectedRect(state);
  const tr = state.tr;
  const refresh = () => {
    const table = tr.doc.nodeAt(original.tableStart - 1);
    return { ...original, table, map: TableMap.get(table) };
  };
  const rows = Math.max(1, Math.min(100, Number(options.rows) || 1));
  const cols = Math.max(1, Math.min(50, Number(options.cols) || 1));
  let rect = refresh();
  while (rect.map.width < cols) { addColumn(tr, rect, rect.map.width); rect = refresh(); }
  while (rect.map.width > cols) { removeColumn(tr, rect, rect.map.width - 1); rect = refresh(); }
  while (rect.map.height < rows) { addRow(tr, rect, rect.map.height); rect = refresh(); }
  while (rect.map.height > rows) { removeRow(tr, rect, rect.map.height - 1); rect = refresh(); }
  const attrs = createTableContent({ ...options, rows: 1, cols: 1 }).attrs;
  const tableStyle = styleOf(rect.table);
  const newStyle = document.createElement('table').style;
  newStyle.cssText = attrs.style;
  for (let index = 0; index < newStyle.length; index++) {
    const property = newStyle.item(index);
    tableStyle.setProperty(property, newStyle.getPropertyValue(property));
  }
  tr.setNodeMarkup(rect.tableStart - 1, undefined, { ...rect.table.attrs, ...attrs, style: tableStyle.cssText });
  for (const cell of cellsOf(rect.table)) {
    const style = styleOf(cell.node);
    style.padding = `${attrs.cellpadding}px`;
    style.border = `${attrs.border}px solid #808080`;
    const type = cell.top === 0 ? state.schema.nodes[options.header ? 'tableHeader' : 'tableCell'] : cell.node.type;
    tr.setNodeMarkup(rect.tableStart + cell.offset, type, { ...cell.node.attrs, colwidth: null, style: style.cssText });
  }
  dispatch(tr.scrollIntoView());
  return true;
};
