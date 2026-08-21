import { useTranslation } from 'react-i18next';
import { GTD_STATES, GTD_COLORS, resolveAccountGtdFolders, gtdStatesInFolders, unclassifyThread } from '../../utils/gtd.js';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';
import { classifyWithUndo } from './classification.js';

// GTD's context-menu contributions, injected into core's 'context-menu-actions' collector so the
// menu itself carries no GTD-specific code. Placement is preserved: core splices these items into
// the 'Actions' group exactly where the GTD entries used to sit (after "Categorize"). Actions still
// dispatch through the caller-provided onAction ('gtdClassify'/'gtdRemove'/'gtdDone') — the same
// channel core used — now owned by the plugin.

// The classify + remove submenu shown when the "GTD" item is opened. Renders its own back row and
// takes over the menu content area (via core's generic plugin-submenu view). Classify offers every
// state; "Remove from <state>" is offered only for the states this thread is actually labelled with.
function GtdContextSubmenu({ message, account, onClose, onBack }) {
  const { t } = useTranslation();
  const addNotification = useStore(s => s.addNotification);
  const scheduleGtdSectionsFetch = useStore(s => s.scheduleGtdSectionsFetch);
  const gtdFolders = resolveAccountGtdFolders(account);
  const removableStates = gtdStatesInFolders(message.folders, gtdFolders);
  // Classify = COPY into the state's label folder (message stays put); remove = strip that label.
  // Store-based, so they run the same on every surface — no dependency on the caller's onAction.
  const classify = (state) => {
    void classifyWithUndo(message.id, state, {
      api,
      store: { addNotification, scheduleGtdSectionsFetch },
      t,
    });
    onClose();
  };
  const removeFrom = (state) => { unclassifyThread(message.id, state, { gtdUnclassify: api.gtdUnclassify, addNotification, scheduleGtdSectionsFetch, t }); onClose(); };
  return (
    <>
      <div
        onClick={onBack}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', cursor: 'pointer',
          borderBottom: '1px solid var(--border-subtle)',
          color: 'var(--text-secondary)', fontSize: 12,
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        {t('gtd.title')}
      </div>
      {GTD_STATES.map(state => (
        <div
          key={state}
          onClick={() => classify(state)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <span style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: GTD_COLORS[state] }} />
          <span style={{ flex: 1 }}>{t(`gtd.state.${state}`)}</span>
        </div>
      ))}
      {removableStates.length > 0 && (
        <>
          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
          {removableStates.map(state => (
            <div
              key={`rm-${state}`}
              onClick={() => removeFrom(state)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span style={{ flex: 1 }}>{t('gtd.removeFrom', { state: t(`gtd.state.${state}`) })}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

// Build GTD's context-menu items for the 'context-menu-actions' collector. ctx (from ContextMenu):
// { message, account, variant, onAction, onClose, openSubmenu, t }. Returns [] when GTD is off for
// the account (so a non-GTD account contributes nothing). The "Done" entry is sidebar-only, mirroring
// the old menuPolicy.done gate (variant === 'gtdSidebar').
export function buildGtdContextItems(ctx) {
  const { message, account, variant, onAction, onClose, openSubmenu, t } = ctx;
  const items = [];
  if (account?.gtd_enabled) {
    items.push({
      label: t('gtd.title'),
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
      keepOpen: true,
      hasSubmenu: true,
      action: () => openSubmenu((onBack) => (
        <GtdContextSubmenu message={message} account={account} onClose={onClose} onBack={onBack} />
      )),
    });
  }
  // The sidebar's "done" checkmark — section-scoped stripping happens in the caller's onAction.
  if (variant === 'gtdSidebar') {
    items.push({
      label: t('gtd.done'),
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="20 6 9 17 4 12"/></svg>,
      action: () => onAction('gtdDone'),
    });
  }
  return items;
}
