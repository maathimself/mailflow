import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { descale } from '../hooks/useUiScale.js';
import { TABLE_DEFAULTS } from '../utils/editorTable.js';

const GRID_SIZE = 8;

export default function TableInsertMenu({ position, uiScale, containerRef, onInsert, onClose, onRemove, initialAdvanced = false, initialValues = TABLE_DEFAULTS, editing = false }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [selection, setSelection] = useState({ rows: 1, cols: 1 });
  const [advanced, setAdvanced] = useState(initialAdvanced);
  const [values, setValues] = useState(initialValues);
  const dialogRef = useRef(null);

  useEffect(() => {
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [onClose]);

  useEffect(() => {
    if (!advanced) return;
    const previous = document.activeElement;
    dialogRef.current?.querySelector('input')?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [advanced]);

  const update = (key, value) => setValues(current => ({ ...current, [key]: value }));
  const numberField = (key, label, min, max) => (
    <label className="table-insert-field">
      <span>{label}</span>
      <input type="number" required min={min} max={max} step="1" value={values[key]}
        onChange={event => update(key, event.target.value)} />
    </label>
  );
  const trapFocus = event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialogRef.current.querySelectorAll('input, select, button')].filter(el => !el.disabled);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div ref={containerRef}>
      {advanced ? (
        <div className="table-insert-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
          <form ref={dialogRef} className="table-insert-dialog" role="dialog" aria-modal="true"
            aria-labelledby={titleId} onKeyDown={trapFocus}
            onSubmit={event => { event.preventDefault(); onInsert(values); }}>
            <h3 id={titleId}>{editing ? t('compose.tableMenu.properties') : t('compose.toolbar.insertTable')}</h3>
            <fieldset>
              <legend>{t('compose.table.cellProperties')}</legend>
              <div className="table-insert-fields">
                {numberField('rows', t('compose.table.rows'), 1, 100)}
                {numberField('cols', t('compose.table.columns'), 1, 50)}
                {numberField('padding', t('compose.table.cellPadding'), 0, 50)}
                {numberField('spacing', t('compose.table.cellSpacing'), 0, 50)}
              </div>
              <label className="table-insert-check">
                <input type="checkbox" checked={values.header} onChange={event => update('header', event.target.checked)} />
                {t('compose.table.headerRow')}
              </label>
            </fieldset>
            <fieldset>
              <legend>{t('compose.table.tableProperties')}</legend>
              <div className="table-insert-fields">
                {numberField('border', t('compose.table.border'), 0, 20)}
                <label className="table-insert-field">
                  <span>{t('compose.table.alignment')}</span>
                  <select value={values.alignment} onChange={event => update('alignment', event.target.value)}>
                    <option value="">{t('compose.toolbar.fontDefault')}</option>
                    <option value="left">{t('compose.table.alignLeft')}</option>
                    <option value="center">{t('compose.table.alignCenter')}</option>
                    <option value="right">{t('compose.table.alignRight')}</option>
                  </select>
                </label>
                {numberField('width', t('compose.table.width'), 1, values.unit === '%' ? 100 : 2000)}
                <label className="table-insert-field">
                  <span>{t('compose.table.widthUnit')}</span>
                  <select value={values.unit} onChange={event => {
                    update('unit', event.target.value);
                    if (event.target.value === '%' && Number(values.width) > 100) update('width', 100);
                  }}>
                    <option value="%">{t('compose.table.percent')}</option>
                    <option value="px">{t('compose.table.pixels')}</option>
                  </select>
                </label>
              </div>
            </fieldset>
            <div className="table-insert-footer">
              <button type="button" onClick={onClose}>{t('common.cancel')}</button>
              <button type="submit" className="table-insert-submit">{editing ? t('compose.toolbar.apply') : t('compose.toolbar.insertTable')}</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="table-insert-picker" style={{
          top: descale(position.top, uiScale), left: descale(position.left, uiScale),
        }}>
          <div className="table-insert-grid" aria-label={t('compose.toolbar.insertTable')}>
            {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
              const rows = Math.floor(index / GRID_SIZE) + 1;
              const cols = index % GRID_SIZE + 1;
              const selected = rows <= selection.rows && cols <= selection.cols;
              return (
                <button key={index} type="button" className={selected ? 'is-selected' : ''}
                  tabIndex={rows === selection.rows && cols === selection.cols ? 0 : -1}
                  aria-label={t('compose.table.size', { rows, cols })}
                  onMouseEnter={() => setSelection({ rows, cols })}
                  onFocus={() => setSelection({ rows, cols })}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => onInsert({ rows, cols })}
                  onKeyDown={event => {
                    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -GRID_SIZE, ArrowDown: GRID_SIZE }[event.key];
                    if (offset == null) return;
                    event.preventDefault();
                    const next = Math.max(0, Math.min(GRID_SIZE * GRID_SIZE - 1, index + offset));
                    event.currentTarget.parentElement.children[next].focus();
                  }} />
              );
            })}
          </div>
          <div className="table-insert-size" aria-live="polite">{t('compose.table.size', selection)}</div>
          <button type="button" className="table-insert-action" onMouseDown={event => event.preventDefault()}
            onClick={() => setAdvanced(true)}>{t('compose.table.insertCustom')}</button>
          {onRemove && (
            <button type="button" className="table-insert-action table-insert-remove"
              onMouseDown={event => event.preventDefault()} onClick={onRemove}>{t('compose.toolbar.removeTable')}</button>
          )}
        </div>
      )}
    </div>
  );
}
