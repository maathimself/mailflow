import { useTranslation } from 'react-i18next';
import {
  composeChipInteraction,
  composeChipPresentation,
} from './composePresentationModel.js';

function persistenceLabel(session, t) {
  const presentation = composeChipPresentation(session);
  return {
    ...presentation,
    label: t(
      presentation.code === 'terminalPending'
        ? 'compose.sessions.terminalPending'
        : `compose.${presentation.code}`,
      { defaultValue: presentation.defaultLabel },
    ),
  };
}

export default function ComposeChip({ session, onRestore, onFocus, platform }) {
  const { t } = useTranslation();
  const title = session.subject?.trim() || t('common.noSubject');
  const platformName = platform
    || globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform
    || '';
  const isMac = /mac/i.test(platformName);
  const keycap = isMac ? `⌘${session.slot}` : `Ctrl+${session.slot}`;
  const persistence = persistenceLabel(session, t);
  const interaction = composeChipInteraction(session);
  const ariaLabel = `${session.slot}. ${title}. ${persistence.label}. ${keycap}`;

  const activate = () => {
    if (interaction.action === 'restore') onRestore(session.id);
    else if (interaction.action === 'focus') onFocus(session.id);
  };

  return (
    <button
      type="button"
      onClick={activate}
      disabled={interaction.disabled}
      tabIndex={interaction.tabIndex}
      aria-busy={interaction.ariaBusy}
      aria-label={ariaLabel}
      data-compose-slot={session.slot}
      data-compose-state={persistence.code}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        minWidth: 0, maxWidth: 260, height: 34, padding: '0 9px',
        border: '1px solid var(--border)', borderRadius: 7,
        background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
        boxShadow: 'var(--shadow-sm)', cursor: interaction.disabled ? 'default' : 'pointer',
      }}
    >
      <kbd style={{
        flex: 'none', padding: '2px 6px', border: '1px solid var(--border)',
        borderRadius: 4, color: 'var(--text-tertiary)',
        background: 'var(--bg-tertiary)', fontSize: 11, fontWeight: 500,
      }}>
        {keycap}
      </kbd>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {title}
      </span>
      {persistence.indicator && (
        <span aria-hidden="true" title={persistence.label} style={{ color: persistence.warning ? 'var(--danger)' : 'var(--text-tertiary)', flex: 'none' }}>
          {persistence.indicator}
        </span>
      )}
    </button>
  );
}
