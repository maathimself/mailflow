import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageMid } from '../store/index.js';
import {
  GTD_COLORS, GTD_CHIP_BG,
  buildGtdDisplaySections, isSelectedRow,
} from '../utils/gtd.js';
import { getGtdSidebarPreview } from '../utils/gtdSidebar.js';
import { useGtdTriage } from '../hooks/useGtdTriage.js';
import GtdTriageRow from './GtdTriageRow.jsx';
import GtdZeroPet from './GtdZeroPet.jsx';
import ContextMenu from './ContextMenu.jsx';
import RightSidebar from './RightSidebar.jsx';

// Section key -> the state color/chip-bg used for its header, count chip, and the
// row's left border. Waiting rows override per gtdKind (watch/delegated).
const SECTION_STATE = { todo: 'todo', waiting: 'watch', reference: 'reference', someday: 'someday' };

export default function GtdSidebarContent({ onCollapse, toggleHint }) {
  const { t } = useTranslation();
  const gtdSections = useStore(s => s.gtdSections);
  const gtdCollapsedSections = useStore(s => s.gtdCollapsedSections);
  const toggleGtdSection = useStore(s => s.toggleGtdSection);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const selectedMid = useStore(selectSelectedMessageMid);

  // Every triage primitive (hover cluster + right-click menu), the auto-read timer, and the
  // context-menu state now live in the shared hook — the GTD tab browse list mounts its own
  // instance of the same engine, so both surfaces triage identically. Here we only render
  // the sidebar's sections and wire the hook's actions into the rows + the ContextMenu portal.
  const { contextMenu, setContextMenu, handleGtdAction, openRow, rowActions } = useGtdTriage();

  // Sections are fetched by MailApp on context change (single owner); the sidebar
  // just renders the store slice and updates live via gtd_sections_updated.
  const sections = buildGtdDisplaySections(gtdSections);
  const loaded = gtdSections != null;
  const allClear = loaded && sections.every(s => s.total === 0);

  return (
    <RightSidebar
      title={t('gtd.title')}
      headerAccessory={allClear ? (
        <span style={{
          marginLeft: 'auto', fontSize: 10.5, fontWeight: 600,
          color: GTD_COLORS.done, background: GTD_CHIP_BG.done,
          padding: '2px 8px', borderRadius: 9,
        }}>
          {t('gtd.inboxZero')}
        </span>
      ) : null}
      onCollapse={onCollapse}
      toggleHint={toggleHint}
    >

      {allClear ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 8, padding: 20, textAlign: 'center',
        }}>
          <GtdZeroPet />
          <b style={{ color: 'var(--text-primary)', fontSize: 15 }}>{t('gtd.allClear')}</b>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('gtd.allClearHint')}</span>
        </div>
      ) : (
        sections.map(section => (
          <GtdSection
            key={section.key}
            section={section}
            collapsed={!!gtdCollapsedSections[section.key]}
            onToggle={() => toggleGtdSection(section.key)}
            onOpenRow={openRow}
            rowActions={rowActions}
            selectedMessageId={selectedMessageId}
            selectedMid={selectedMid}
            t={t}
          />
        ))
      )}

      {/* Portal to body: the sidebar's own wrapper carries a translateX transform (the
          collapse slide), which would otherwise capture the menu's position:fixed. */}
      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          message={contextMenu.message}
          defaultMoveView={contextMenu.defaultMoveView}
          variant="gtdSidebar"
          onClose={() => setContextMenu(null)}
          onAction={(action, data) => handleGtdAction(action, contextMenu, data)}
        />,
        document.body,
      )}
    </RightSidebar>
  );
}

function GtdSection({ section, collapsed, onToggle, onOpenRow, rowActions, selectedMessageId, selectedMid, t }) {
  const state = SECTION_STATE[section.key];
  const color = GTD_COLORS[state];
  const label = section.key === 'waiting' ? t('gtd.waiting') : t(`gtd.state.${section.key}`);
  const [expanded, setExpanded] = useState(false);
  const preview = getGtdSidebarPreview(section, expanded);


  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* The whole header row folds/unfolds its section — it must never activate an inbox
          pill (that is the "View all" link's job below). Full-row button = a big hit area. */}
      {/* Sticks directly below RightSidebar's own sticky header. The shell publishes that
          header's rendered height as --right-sidebar-header-height, so deriving the offset
          from it keeps this in lockstep if the shell's header box ever changes. */}
      <div style={{
        position: 'sticky', top: 'var(--right-sidebar-header-height, 50px)', background: 'var(--bg-secondary)', zIndex: 2, userSelect: 'none',
      }}>
        <button
          onClick={onToggle}
          aria-label={t('gtd.toggleSection', { section: label })}
          aria-expanded={!collapsed}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '8px 14px',
            background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit',
            transition: 'all 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
        >
          <span style={{ display: 'flex', width: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            <svg
              width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
            >
              <polyline points={collapsed ? '9 18 15 12 9 6' : '6 9 12 15 18 9'} />
            </svg>
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.09em', color, textTransform: 'uppercase' }}>
            {label}
          </span>
        </button>
      </div>

      {!collapsed && (
        <div>
          {preview.threads.map(thread => (
            <GtdTriageRow
              key={thread.id ?? thread.message_id}
              thread={thread}
              sectionKey={section.key}
              variant="sidebar"
              onOpen={() => onOpenRow(thread)}
              rowActions={rowActions}
              selected={isSelectedRow(thread, selectedMessageId, selectedMid)}
              t={t}
            />
          ))}
          {preview.expandable && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
              style={{
                width: '100%', padding: '5px 24px 9px', border: 0,
                background: 'transparent', textAlign: 'left',
                fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              {expanded
                ? `${t('gtd.showLess')} ↑`
                : `${t(preview.bounded ? 'gtd.showSome' : 'gtd.showAll', {
                    available: preview.available,
                    total: preview.total,
                    count: preview.total,
                  })} →`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
