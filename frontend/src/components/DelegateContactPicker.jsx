import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCommandRuntimeContext } from '../commands/CommandRuntimeContext.jsx';
import { api } from '../utils/api.js';
import {
  contactOption,
  createPickerRequestGate,
  nextPickerIndex,
} from '../utils/delegation.js';

function focusableElements(container) {
  return [...container.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
}

export default function DelegateContactPicker({ targetCount, onSelect, onCancel }) {
  const { t } = useTranslation();
  const titleId = useId();
  const listboxId = useId();
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const optionRefs = useRef([]);
  const gateRef = useRef(createPickerRequestGate());
  const restoreFocusRef = useRef(document.activeElement);
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const previousFocus = restoreFocusRef.current;
    searchRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, []);

  useEffect(() => {
    const requestId = gateRef.current.start();
    setLoading(true);
    setError(null);
    setContacts([]);
    setActiveIndex(-1);
    const timer = setTimeout(async () => {
      try {
        const response = await api.getContacts({ q: query.trim(), limit: 30, offset: 0 });
        if (!gateRef.current.isCurrent(requestId)) return;
        const next = (response?.contacts || (Array.isArray(response) ? response : []))
          .map(contactOption)
          .filter(contact => contact.id && contact.label);
        setContacts(next);
        setActiveIndex(next.length ? 0 : -1);
      } catch (cause) {
        if (gateRef.current.isCurrent(requestId)) setError(cause);
      } finally {
        if (gateRef.current.isCurrent(requestId)) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, retryKey]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const chooseActive = useCallback(() => {
    const contact = contacts[activeIndex];
    if (contact) onSelect(contact.id);
  }, [activeIndex, contacts, onSelect]);

  const handleKeyDown = (event) => {
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => nextPickerIndex(index, 1, contacts.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => nextPickerIndex(index, -1, contacts.length));
    } else if (event.key === 'Enter' && activeIndex >= 0 && event.target === searchRef.current) {
      event.preventDefault();
      chooseActive();
    } else if (event.key === 'Tab' && dialogRef.current) {
      const focusable = focusableElements(dialogRef.current);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="delegate-picker__backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section
        ref={dialogRef}
        className="delegate-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <header className="delegate-picker__header">
          <div>
            <h2 id={titleId}>{t('gtd.delegate.pickerTitle', { count: targetCount })}</h2>
            <p>{t('gtd.delegate.pickerHint')}</p>
          </div>
          <button type="button" className="delegate-picker__close" onClick={onCancel}
            aria-label={t('common.close')} title={t('common.close')}>×</button>
        </header>

        <label className="delegate-picker__search">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <span className="sr-only">{t('gtd.delegate.search')}</span>
          <input
            ref={searchRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('gtd.delegate.search')}
            role="combobox"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${contacts[activeIndex]?.id}` : undefined}
          />
        </label>

        <div id={listboxId} role="listbox" className="delegate-picker__results"
          aria-busy={loading} aria-label={t('gtd.delegate.contacts')}>
          {loading && <div className="delegate-picker__state">{t('common.loading')}</div>}
          {!loading && error && <div className="delegate-picker__state">
            <span>{t('gtd.delegate.loadFailed')}</span>
            <button type="button" onClick={() => setRetryKey(key => key + 1)}>{t('gtd.delegate.retry')}</button>
          </div>}
          {!loading && !error && contacts.length === 0 && (
            <div className="delegate-picker__state">{t('gtd.delegate.empty')}</div>
          )}
          {!loading && !error && contacts.map((contact, index) => (
            <button
              ref={element => { optionRefs.current[index] = element; }}
              id={`${listboxId}-option-${contact.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              key={contact.id}
              className="delegate-picker__option"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelect(contact.id)}
            >
              <span className="delegate-picker__avatar" aria-hidden="true">
                {contact.label.slice(0, 1).toUpperCase()}
              </span>
              <span className="delegate-picker__identity">
                <strong>{contact.label}</strong>
                {contact.email && contact.email !== contact.label && <small>{contact.email}</small>}
              </span>
            </button>
          ))}
        </div>

        <footer className="delegate-picker__footer">
          <button type="button" className="delegate-picker__without" onClick={() => onSelect(null)}>
            {t('gtd.delegate.withoutPerson')}
          </button>
          <span><kbd>Esc</kbd> {t('common.cancel')}</span>
        </footer>
      </section>
    </div>
  );
}

export function DelegateContactContinuationHost({ onOpen }) {
  const { controller, continuation, clearContinuation } = useCommandRuntimeContext();
  const isContact = continuation?.kind === 'contact';
  useEffect(() => { if (isContact) onOpen?.(); }, [isContact, onOpen]);
  if (!isContact) return null;

  return (
    <DelegateContactPicker
      targetCount={continuation.targetIds.length}
      onCancel={clearContinuation}
      onSelect={(contactId) => {
        const { commandId, targetIds } = continuation;
        clearContinuation();
        void controller.execute(commandId, {
          source: 'continuation',
          input: { contactId },
          frozenTargetIds: targetIds,
        });
      }}
    />
  );
}
