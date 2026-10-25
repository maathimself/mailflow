import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiScale, descale } from '../hooks/useUiScale.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { copyEditorSelection, readComposerClipboard, textParagraphs } from '../utils/composerClipboard.js';
import { CellSelection, isInTable } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import ColorMenuSection, { HIGHLIGHT_COLORS } from './ColorMenuSection.jsx';
import { selectedTableCells, shadeTableCells, alignTableCells, setTableBorders, splitTableCell, splitTable, deleteTablePart } from '../utils/editorTableActions.js';

function submenuAnchor(button) {
  const row = button.getBoundingClientRect();
  const panel = button.closest('[role="menu"]').getBoundingClientRect();
  // Anchor to the panel edge so adjacent menus do not cover the parent's hover area.
  return { left: panel.left, right: panel.right, top: row.top, bottom: row.bottom };
}

function MenuPanel({ items = [], content, point, anchor, scale, autoFocus, onSubmenu, onBack, onClose, onScroll }) {
  const ref = useRef(null);
  const [position, setPosition] = useState(null);
  const positioned = position !== null;
  useLayoutEffect(() => {
    const panel = ref.current;
    const measure = () => {
      const rect = panel.getBoundingClientRect();
      const x = anchor ? (anchor.right + rect.width <= window.innerWidth - 4 ? anchor.right : anchor.left - rect.width) : point.x;
      const y = anchor ? anchor.top : point.y;
      const next = { x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) };
      setPosition(previous => previous?.x === next.x && previous?.y === next.y ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [point, anchor, scale]);

  useLayoutEffect(() => {
    if (positioned && autoFocus) ref.current.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [positioned, autoFocus]);

  return (
    <div ref={ref} role="menu" className="composer-context-menu" onScroll={onScroll} onContextMenu={event => event.preventDefault()}
      style={{ left: descale(position?.x ?? 0, scale), top: descale(position?.y ?? 0, scale),
        visibility: positioned ? 'visible' : 'hidden', maxHeight: descale(window.innerHeight - 8, scale) }}
      onKeyDown={event => {
        const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        let next;
        if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
        if (event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        if (next != null) { event.preventDefault(); buttons[next]?.focus(); }
        if (event.key === 'ArrowLeft' && onBack) { event.preventDefault(); onBack(); }
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); }
        event.stopPropagation();
      }}>
      {content}
      {items.map((item, index) => item == null ? <div key={`sep-${index}`} role="separator" className="composer-context-separator" /> : (
        <button key={item.id} type="button" role={item.checked == null ? 'menuitem' : 'menuitemcheckbox'}
          data-action={item.id} aria-checked={item.checked} aria-haspopup={item.children || item.render ? 'menu' : undefined}
          disabled={item.disabled} onMouseDown={event => event.preventDefault()}
          onMouseEnter={event => onSubmenu?.((item.children || item.render) && !item.disabled ? { item, anchor: submenuAnchor(event.currentTarget), trigger: event.currentTarget } : null)}
          onKeyDown={event => {
            if (event.key === 'ArrowRight' && (item.children || item.render)) {
              event.preventDefault(); event.stopPropagation();
              onSubmenu?.({ item, anchor: submenuAnchor(event.currentTarget), trigger: event.currentTarget, keyboard: true });
            }
          }}
          onClick={event => item.children || item.render ? onSubmenu?.({ item, anchor: submenuAnchor(event.currentTarget), trigger: event.currentTarget, keyboard: true }) : item.action()}>
          <span className="composer-context-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
          <span>{item.label}</span>
          {(item.children || item.render) && <span className="composer-context-arrow" aria-hidden="true">›</span>}
        </button>
      ))}
    </div>
  );
}

// One controller for the rich body, plain-text body and HTML source. Its snapshot
// keeps menu focus and asynchronous clipboard reads from changing the edit range.
export default function ComposerContextMenu({ editor, textTargetRef, plain, htmlMode, disabled,
  onTool, onAttach, onImage, onPasteImage, onSignature, signatureAvailable, signatureEnabled,
  onToggleHtml, aiEnabled, onAiAction, onError }) {
  const { t } = useTranslation();
  const scale = useUiScale();
  const [menu, setMenu] = useState(null);
  const [submenus, setSubmenus] = useState([]);
  const [emoji, setEmoji] = useState(null);
  const history = useRef({ entries: [], index: 0, applying: false });
  const rich = !plain && !htmlMode;

  useEffect(() => {
    const target = rich ? editor?.view.dom : textTargetRef.current;
    if (!target || disabled) return;
    history.current = { entries: [target.value ?? ''], index: 0, applying: false };
    const record = () => {
      const state = history.current;
      if (state.applying || state.entries[state.index] === target.value) return;
      state.entries = [...state.entries.slice(0, state.index + 1), target.value].slice(-100);
      state.index = state.entries.length - 1;
    };
    const open = event => {
      event.preventDefault(); event.stopPropagation();
      if (rich) {
        const clickedCell = event.target.closest?.('td, th');
        let cellPosition = null;
        if (clickedCell && target.contains(clickedCell)) cellPosition = editor.view.posAtDOM(clickedCell, 0) - 1;
        const insideSelectedCell = cellPosition != null && selectedTableCells(editor.state).some(cell => cell.pos === cellPosition);
        const keepCells = editor.state.selection instanceof CellSelection && insideSelectedCell;
        try {
          const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
          const { from, to, empty } = editor.state.selection;
          if (!keepCells && hit && (empty || hit.pos < from || hit.pos > to || (clickedCell && !isInTable(editor.state)))) editor.commands.setTextSelection(hit.pos);
          else if (!keepCells && !hit && cellPosition != null && !insideSelectedCell) {
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(cellPosition + 1))));
          }
        } catch {
          if (cellPosition != null && !keepCells && !insideSelectedCell) {
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(cellPosition + 1))));
          }
        }
      }
      const rect = target.getBoundingClientRect();
      setMenu({
        x: event.clientX || rect.left + 16, y: event.clientY || rect.top + 16,
        selection: rich ? editor.state.selection : { from: target.selectionStart, to: target.selectionEnd },
        doc: rich ? editor.state.doc : null, value: target.value, target,
      });
      setSubmenus([]); setEmoji(null);
    };
    target.addEventListener('contextmenu', open);
    if (!rich) target.addEventListener('input', record);
    return () => { target.removeEventListener('contextmenu', open); target.removeEventListener('input', record); };
  }, [editor, rich, htmlMode, textTargetRef, disabled]);

  useEffect(() => { setMenu(null); setSubmenus([]); setEmoji(null); }, [rich, htmlMode, disabled]);

  if (!menu && !emoji) return null;
  const close = (focus = false) => {
    setMenu(null); setSubmenus([]); setEmoji(null);
    if (focus) {
      if (rich) editor.view.focus();
      else textTargetRef.current?.focus({ preventScroll: true });
    }
  };
  const changeText = (target, value, from, to = from) => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(target, value);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    target.focus({ preventScroll: true });
    target.setSelectionRange(from, to);
  };
  const replaceText = (snapshot, text) => {
    if (!snapshot.target.isConnected || snapshot.target.value !== snapshot.value) return;
    const { from, to } = snapshot.selection;
    changeText(snapshot.target, snapshot.value.slice(0, from) + text + snapshot.value.slice(to), from + text.length);
  };
  const command = action => {
    if (!editor || editor.isDestroyed || editor.state.doc !== menu.doc) return;
    action(editor.chain().focus().command(({ tr }) => { tr.setSelection(menu.selection); return true; })).run();
  };
  const run = action => () => {
    close(true);
    Promise.resolve().then(action).catch(() => onError(t('compose.context.clipboardError')));
  };
  const tool = name => run(() => onTool({ action: name, x: menu.x, y: menu.y, selection: menu.selection }));
  const copy = async cut => {
    const snapshot = menu;
    const ok = rich ? await copyEditorSelection(editor, snapshot.selection)
      : (await copyToClipboard(snapshot.value.slice(snapshot.selection.from, snapshot.selection.to))).ok;
    if (!ok) { onError(t('common.copyFailed')); return; }
    if (cut) {
      if (rich) command(chain => chain.deleteSelection());
      else replaceText(snapshot, '');
    }
  };
  const paste = async mode => {
    const snapshot = menu;
    const data = await readComposerClipboard(rich && mode === 'paste');
    if (!data) { onError(t('compose.context.pasteUnavailable')); return; }
    if (!data.image && !data.html && !data.text) return;
    if (rich) {
      if (editor.isDestroyed || editor.state.doc !== snapshot.doc) return;
      if (data.image) {
        editor.commands.setTextSelection(snapshot.selection);
        await onPasteImage(data.image);
      } else if (data.html) command(chain => chain.insertContent(data.html));
      else command(chain => chain.insertContent(mode === 'quote'
        ? { type: 'blockquote', content: textParagraphs(data.text) } : textParagraphs(data.text)));
    } else {
      replaceText(snapshot, mode === 'quote' ? data.text.split(/\r?\n/).map(line => `> ${line}`).join('\n') : data.text);
    }
  };
  const textHistory = direction => {
    const state = history.current;
    const index = state.index + direction;
    if (index < 0 || index >= state.entries.length) return;
    state.index = index; state.applying = true;
    const value = state.entries[index];
    changeText(menu.target, value, value.length);
    state.applying = false;
  };
  const showEmoji = async () => {
    if (rich) { onTool({ action: 'emoji', x: menu.x, y: menu.y, selection: menu.selection }); return; }
    const [{ default: Picker }, { default: data }] = await Promise.all([import('@emoji-mart/react'), import('@emoji-mart/data')]);
    setEmoji({ Picker, data, snapshot: menu });
  };

  if (emoji) {
    const { Picker, data, snapshot } = emoji;
    return <>
      <div className="composer-context-scrim" onMouseDown={() => close()} />
      <div className="composer-context-emoji" style={{ left: descale(Math.max(4, Math.min(snapshot.x, window.innerWidth - 300)), scale), top: descale(Math.max(4, Math.min(snapshot.y, window.innerHeight - 420)), scale) }}>
        <Picker data={data} theme="auto" previewPosition="none" onEmojiSelect={item => { replaceText(snapshot, item.native); close(); }} />
      </div>
    </>;
  }

  const item = (id, label, action, options = {}) => ({ id, label, action: run(action), ...options });
  const format = (id, label, method, mark) => item(id, label, () => command(chain => chain[method]()), { checked: mark ? editor?.isActive(mark) : undefined });
  const selected = menu.selection.from !== menu.selection.to;
  const fontSize = delta => {
    const size = editor.getAttributes('textStyle').fontSize || '14px';
    const pixels = (parseFloat(size) || 14) * (size.endsWith('pt') ? 4 / 3 : 1);
    command(chain => chain.setFontSize(`${Math.max(8, Math.min(96, Math.round(pixels + delta)))}px`));
  };
  const formatItems = [
    { id: 'font', label: t('compose.toolbar.typography'), action: tool('font') }, null,
    item('normal', t('compose.context.normal'), () => command(chain => chain.unsetAllMarks().clearNodes().setTextAlign('left').updateAttributes('paragraph', { indent: 0 }))),
    format('bold', t('compose.context.bold'), 'toggleBold', 'bold'),
    format('italic', t('compose.context.italic'), 'toggleItalic', 'italic'),
    format('underline', t('compose.context.underline'), 'toggleUnderline', 'underline'),
    format('superscript', t('compose.context.superscript'), 'toggleSuperscript', 'superscript'),
    format('subscript', t('compose.context.subscript'), 'toggleSubscript', 'subscript'),
    format('strikeout', t('compose.context.strikeout'), 'toggleStrike', 'strike'), null,
    item('fontIncrease', t('compose.context.fontIncrease'), () => fontSize(2)),
    item('fontDecrease', t('compose.context.fontDecrease'), () => fontSize(-2)), null,
    item('indentIncrease', t('compose.context.indentIncrease'), () => command(chain => chain.changeIndent(1))),
    item('indentDecrease', t('compose.context.indentDecrease'), () => command(chain => chain.changeIndent(-1))), null,
    format('bullets', t('compose.context.bullets'), 'toggleBulletList', 'bulletList'),
    format('numbering', t('compose.context.numbering'), 'toggleOrderedList', 'orderedList'),
  ];
  const justifyItems = [
    ['left', t('compose.table.alignLeft')], ['center', t('compose.table.alignCenter')],
    ['right', t('compose.table.alignRight')],
  ].map(([alignment, label]) => item(`align-${alignment}`, label, () => command(chain => chain.setTextAlign(alignment)), { checked: rich && editor.isActive({ textAlign: alignment }) }));
  const insertItems = [
    item('signature', t('compose.context.signature'), onSignature, { disabled: !signatureAvailable, checked: signatureEnabled }),
    item('file', t('compose.context.file'), onAttach),
    item('image', t('compose.context.image'), onImage, { disabled: !rich }),
    { id: 'link', label: t('compose.context.link'), action: tool('link'), disabled: !rich },
    { id: 'table', label: t('compose.context.table'), action: tool('table'), disabled: !rich },
  ];
  const inTable = rich && isInTable(editor.state);
  const tableCommand = action => () => command(chain => chain.command(({ state, dispatch }) => action(state, dispatch)));
  const tableAction = (id, label, action) => item(id, label, tableCommand(action), { disabled: !inTable || !action(editor.state) });
  const cellStyle = document.createElement('td').style;
  if (inTable) cellStyle.cssText = selectedTableCells(editor.state)[0]?.node.attrs.style || '';
  const tableItems = [
    { id: 'table-shading', label: t('compose.tableMenu.shading'), render: () => (
      <div style={{ padding: '8px 12px' }}>
        <ColorMenuSection title={t('compose.tableMenu.shading')} colors={HIGHLIGHT_COLORS}
          activeColor={cellStyle.backgroundColor}
          onColor={color => { close(true); tableCommand(shadeTableCells(color))(); }}
          onClear={() => { close(true); tableCommand(shadeTableCells(null))(); }}
          clearLabel={t('compose.toolbar.removeHighlight')} customColorLabel={t('compose.toolbar.customColor')}
          noColorLabel={t('compose.toolbar.noColor')} showNoColor />
      </div>
    ) },
    { id: 'table-align', label: t('compose.tableMenu.align'), children: [
      ['top', 'left', t('compose.tableMenu.topLeft')], ['top', 'center', t('compose.tableMenu.topCenter')], ['top', 'right', t('compose.tableMenu.topRight')],
      ['middle', 'left', t('compose.tableMenu.centerLeft')], ['middle', 'center', t('compose.table.alignCenter')], ['middle', 'right', t('compose.tableMenu.centerRight')],
      ['bottom', 'left', t('compose.tableMenu.bottomLeft')], ['bottom', 'center', t('compose.tableMenu.bottomCenter')], ['bottom', 'right', t('compose.tableMenu.bottomRight')],
    ].map(([vertical, horizontal, label]) => ({ ...tableAction(`cell-align-${vertical}-${horizontal}`, label, alignTableCells(vertical, horizontal)),
      checked: (cellStyle.verticalAlign || 'top') === vertical && (cellStyle.textAlign || 'left') === horizontal })) },
    { id: 'table-border', label: t('compose.table.border'), children: [
      tableAction('border-bottom', t('compose.tableMenu.bottomBorder'), setTableBorders('Bottom')),
      tableAction('border-top', t('compose.tableMenu.topBorder'), setTableBorders('Top')),
      tableAction('border-left', t('compose.tableMenu.leftBorder'), setTableBorders('Left')),
      tableAction('border-right', t('compose.tableMenu.rightBorder'), setTableBorders('Right')), null,
      tableAction('border-none', t('compose.tableMenu.noBorder'), setTableBorders('none')),
      tableAction('border-all', t('compose.tableMenu.allBorders'), setTableBorders('all')),
      tableAction('border-outside', t('compose.tableMenu.outsideBorders'), setTableBorders('outside')),
      tableAction('border-inside', t('compose.tableMenu.insideBorders'), setTableBorders('inside')),
    ] }, null,
    { id: 'table-insert', label: t('compose.context.insert'), children: [
      item('column-left', t('compose.tableMenu.columnLeft'), () => command(chain => chain.addColumnBefore())),
      item('column-right', t('compose.tableMenu.columnRight'), () => command(chain => chain.addColumnAfter())),
      item('row-above', t('compose.tableMenu.rowAbove'), () => command(chain => chain.addRowBefore())),
      item('row-below', t('compose.tableMenu.rowBelow'), () => command(chain => chain.addRowAfter())),
    ] },
    { id: 'table-delete', label: t('common.delete'), children: [
      tableAction('delete-rows', t('compose.table.rows'), deleteTablePart('rows')),
      tableAction('delete-columns', t('compose.table.columns'), deleteTablePart('columns')),
      item('delete-table', t('compose.context.table'), () => command(chain => chain.deleteTable())),
    ] },
    { id: 'table-split-cells', label: t('compose.tableMenu.splitCells'), children: [
      tableAction('split-horizontal', t('compose.tableMenu.horizontally'), splitTableCell('horizontal')),
      tableAction('split-vertical', t('compose.tableMenu.vertically'), splitTableCell('vertical')),
    ] },
    item('table-merge', t('compose.tableMenu.mergeCells'), () => command(chain => chain.mergeCells()), { disabled: !inTable || !editor.can().mergeCells() }),
    tableAction('table-split', t('compose.tableMenu.splitTable'), splitTable), null,
    { id: 'table-properties', label: t('compose.tableMenu.properties'), action: tool('tableProperties') },
  ];
  const items = [
    item('emoji', t('compose.context.emoji'), showEmoji),
    ...(inTable ? [{ id: 'table-menu', label: t('compose.context.table'), children: tableItems }] : []), null,
    item('cut', t('compose.context.cut'), () => copy(true), { disabled: !selected }),
    item('copy', t('common.copy'), () => copy(false), { disabled: !selected }),
    item('paste', t('compose.context.paste'), () => paste('paste')),
    item('pasteText', t('compose.context.pasteText'), () => paste('text')),
    item('pasteQuote', t('compose.context.pasteQuote'), () => paste('quote'), { disabled: htmlMode }), null,
    item('undo', t('common.undo'), () => rich ? command(chain => chain.undo()) : textHistory(-1), { disabled: rich ? !editor.can().undo() : history.current.index === 0 }),
    item('redo', t('compose.context.redo'), () => rich ? command(chain => chain.redo()) : textHistory(1), { disabled: rich ? !editor.can().redo() : history.current.index >= history.current.entries.length - 1 }), null,
    item('selectAll', t('messageList.selectAll'), () => rich ? command(chain => chain.selectAll()) : changeText(menu.target, menu.value, 0, menu.value.length)), null,
    { id: 'format', label: t('compose.context.format'), children: formatItems, disabled: !rich },
    { id: 'justify', label: t('compose.context.justify'), children: justifyItems, disabled: !rich }, null,
    { id: 'insert', label: t('compose.context.insert'), children: insertItems },
    ...(aiEnabled && rich ? [{ id: 'ai', label: t('compose.context.ai'), children: [
      item('draft', t('compose.toolbar.aiWriteDraft'), () => onAiAction('draft')),
      item('improve', t('compose.toolbar.aiImprove'), () => onAiAction('improve')),
      item('shorten', t('compose.toolbar.aiShorten'), () => onAiAction('shorten')),
      item('grammar', t('compose.toolbar.aiFixGrammar'), () => onAiAction('grammar')),
    ] }] : []),
    item('source', t('compose.context.source'), onToggleHtml, { disabled: plain, checked: htmlMode }),
  ];
  const point = menu;
  const openSubmenu = (level, value) => setSubmenus(current => {
    if (!value) return current.length <= level ? current : current.slice(0, level);
    const existing = current[level];
    if (existing?.item.id === value.item.id && existing.trigger === value.trigger) {
      if (value.keyboard && !existing.keyboard) {
        return current.map((entry, index) => index === level ? { ...entry, keyboard: true } : entry);
      }
      return current;
    }
    return [...current.slice(0, level), value];
  });
  return <>
    <div className="composer-context-scrim" onMouseDown={() => close(true)} onContextMenu={event => { event.preventDefault(); close(true); }} />
    <MenuPanel items={items} point={point} scale={scale} autoFocus onSubmenu={value => openSubmenu(0, value)} onClose={() => close(true)} onScroll={() => openSubmenu(0, null)} />
    {submenus.map((submenu, level) => <MenuPanel key={`${level}-${submenu.item.id}`} items={submenu.item.children}
      content={submenu.item.render?.()} point={point} anchor={submenu.anchor} scale={scale}
      autoFocus={submenu.keyboard} onClose={() => close(true)} onSubmenu={value => openSubmenu(level + 1, value)}
      onScroll={() => openSubmenu(level + 1, null)}
      onBack={() => { submenu.trigger.focus(); openSubmenu(level, null); }} />)}
  </>;
}
