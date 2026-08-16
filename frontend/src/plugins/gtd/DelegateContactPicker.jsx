import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { createPickerRequestGate, nextPickerIndex, normalizeContactOptions } from './contactPicker.js';

export default function DelegateContactPicker({ targetCount, onSelect, onCancel, initialError = null }) {
  const { t } = useTranslation();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const gateRef = useRef(createPickerRequestGate());
  const restoreFocusRef = useRef(null);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(initialError);

  const load = useCallback(async (q) => {
    const request = gateRef.current.issue();
    setLoading(true);
    setError(null);
    try {
      const result = await api.getContacts({ q, limit: 30, offset: 0 });
      if (!gateRef.current.isCurrent(request)) return;
      const next = normalizeContactOptions(result?.contacts);
      setOptions(next);
      setActive(next.length ? 0 : -1);
    } catch (err) {
      if (gateRef.current.isCurrent(request)) setError(err.message || t('gtd.delegate.loadFailed'));
    } finally {
      if (gateRef.current.isCurrent(request)) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => { void load(query.trim()); }, 200);
    return () => clearTimeout(timer);
  }, [query, load]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => nextPickerIndex(index, event.key === 'ArrowDown' ? 1 : -1, options.length));
      return;
    }
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      onSelect(options[active].id);
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [...dialogRef.current.querySelectorAll('input,button,[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };

  return (
    <div className="gtd-delegate-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={dialogRef} className="gtd-delegate-dialog" role="dialog" aria-modal="true" aria-labelledby="gtd-delegate-title" onKeyDown={onKeyDown}>
        <h2 id="gtd-delegate-title">{t('gtd.delegate.title', { count: targetCount })}</h2>
        <p>{t('gtd.delegate.hint')}</p>
        <input
          ref={inputRef}
          role="combobox"
          aria-controls="gtd-delegate-list"
          aria-expanded="true"
          aria-activedescendant={active >= 0 ? `gtd-delegate-option-${active}` : undefined}
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('gtd.delegate.search')}
        />
        <div id="gtd-delegate-list" className="gtd-delegate-list" role="listbox">
          {loading && <div className="gtd-delegate-status">{t('common.loading')}</div>}
          {!loading && error && (
            <div className="gtd-delegate-status">
              <span>{t('gtd.delegate.loadFailed')}</span>
              <button type="button" onClick={() => void load(query.trim())}>{t('gtd.delegate.retry')}</button>
            </div>
          )}
          {!loading && !error && options.length === 0 && <div className="gtd-delegate-status">{t('gtd.delegate.empty')}</div>}
          {!loading && !error && options.map((option, index) => (
            <button
              type="button"
              id={`gtd-delegate-option-${index}`}
              role="option"
              aria-selected={active === index}
              className={active === index ? 'gtd-delegate-option active' : 'gtd-delegate-option'}
              key={option.id}
              onMouseEnter={() => setActive(index)}
              onClick={() => onSelect(option.id)}
            >
              <strong>{option.label}</strong>
              {option.email && option.email !== option.label && <span>{option.email}</span>}
            </button>
          ))}
        </div>
        <div className="gtd-delegate-footer">
          <button type="button" onClick={() => onSelect(null)}>{t('gtd.delegate.withoutPerson')}</button>
          <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}
