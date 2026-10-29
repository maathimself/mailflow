import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

// Stable identifiers are kept separate from translated labels so saved templates work in any locale.
const VARIABLE_GROUPS = [
  { label: 'templates.variables.groups.date', items: [
    ['date.date', 'templates.variables.date'], ['date.longDate', 'templates.variables.longDate'],
    ['date.dateTime', 'templates.variables.dateTime'], ['date.month', 'templates.variables.month'],
  ] },
  { label: 'templates.variables.groups.contact', items: [
    ['contact.fullName', 'templates.variables.fullName'], ['contact.givenName', 'templates.variables.givenName'],
    ['contact.surname', 'templates.variables.surname'], ['contact.salutation', 'templates.variables.salutation'],
    ['contact.prefix', 'templates.variables.prefix'], ['contact.suffix', 'templates.variables.suffix'],
    ['contact.title', 'templates.variables.title'], ['contact.company', 'templates.variables.company'],
  ] },
  { label: 'templates.variables.groups.address', items: [
    ['address.home', 'templates.variables.homeAddress'], ['address.homeInline', 'templates.variables.homeAddressInline'],
    ['address.work', 'templates.variables.workAddress'], ['address.workInline', 'templates.variables.workAddressInline'],
  ] },
  { label: 'templates.variables.groups.email', items: [
    ['email.address', 'templates.variables.emailAddress'], ['email.displayAs', 'templates.variables.displayAs'],
    ['email.work', 'templates.variables.workEmail'],
  ] },
  { label: 'templates.variables.groups.phone', items: [
    ['phone.mobile', 'templates.variables.mobilePhone'], ['phone.home', 'templates.variables.homePhone'],
    ['phone.work', 'templates.variables.workPhone'],
  ] },
];

const tokenFor = variable => `{{ ${variable} }}`;

function VariableModal({ onInsert, onClose }) {
  const { t } = useTranslation();
  const id = useId();
  const [selected, setSelected] = useState(VARIABLE_GROUPS[0].items[0][0]);
  const [expandedGroup, setExpandedGroup] = useState(VARIABLE_GROUPS[0].label);
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.querySelector('.template-variable-header')?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);
  return createPortal(<div className="template-variable-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      // Only the selected radio belongs to the native radio group's Tab sequence.
      const focusable = [...dialog.current.querySelectorAll('input:checked, button:not(:disabled)')]
        .filter(element => !element.closest('[hidden]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div ref={dialog} className="template-variable-modal" role="dialog" aria-modal="true" aria-label={t('templates.variables.insert')}
      aria-describedby={`${id}-hint`}>
      <h2>{t('templates.variables.insert')}</h2>
      <p id={`${id}-hint`} className="templates-hint">{t('templates.variables.hint')}</p>
      <div className="template-variable-groups">
        {VARIABLE_GROUPS.map((group, index) => <section key={group.label}>
          <h3><button type="button" className="template-variable-header" aria-expanded={expandedGroup === group.label}
            aria-controls={`${id}-group-${index}`} onClick={() => {
              setExpandedGroup(expandedGroup === group.label ? null : group.label);
              if (!group.items.some(([value]) => value === selected)) setSelected(group.items[0][0]);
            }}>
            <span>{t(group.label)}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={expandedGroup === group.label ? 'M6 15l6-6 6 6' : 'M9 6l6 6-6 6'} /></svg>
          </button></h3>
          <div id={`${id}-group-${index}`} className="template-variable-items" hidden={expandedGroup !== group.label}>
          {group.items.map(([value, label]) => <label key={value} className="template-variable-option">
            <input type="radio" name={`${id}-variable`} value={value} checked={selected === value} onChange={() => setSelected(value)} />
            <span>{t(label)}</span>
          </label>)}
          </div>
        </section>)}
      </div>
      <output className="template-variable-preview" aria-live="polite">{tokenFor(selected)}</output>
      <div className="templates-actions">
        <button type="button" data-action="insert-variable" onClick={() => onInsert(tokenFor(selected))}>{t('templates.variables.confirm')}</button>
        <button type="button" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  </div>, document.body);
}

export default function TemplateEditorActions({ context }) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(null);
  const variableButton = useRef(null);
  const close = () => { setSelection(null); variableButton.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={variableButton} className="template-editor-action" type="button" disabled={context.disabled}
      title={t('templates.variables.insert')} aria-label={t('templates.variables.insert')} aria-haspopup="dialog" aria-expanded={!!selection}
      onMouseDown={event => event.preventDefault()} onClick={() => { if (!context.disabled) setSelection(context.captureSelection()); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M8 3H6a2 2 0 0 0-2 2v4l-2 3 2 3v4a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v4l2 3-2 3v4a2 2 0 0 1-2 2h-2M9 9l6 6M15 9l-6 6" />
      </svg>
    </button>
    <button className="template-editor-action" type="button" disabled={context.disabled}
      title={t('templates.variables.placeholder')} aria-label={t('templates.variables.placeholder')}
      onMouseDown={event => event.preventDefault()} onClick={() => context.insertText('{{ add placeholder }}', context.captureSelection())}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 2" /><path d="M12 9v6M9 12h6" />
      </svg>
    </button>
    {selection && !context.disabled && <VariableModal onClose={close} onInsert={text => {
      close(); context.insertText(text, selection);
    }} />}
  </>;
}
