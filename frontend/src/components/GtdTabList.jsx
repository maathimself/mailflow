import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageMid } from '../store/index.js';
import { buildGtdDisplaySections, isSelectedRow } from '../utils/gtd.js';
import { useGtdTriage } from '../hooks/useGtdTriage.js';
import GtdTriageRow from './GtdTriageRow.jsx';
import ContextMenu from './ContextMenu.jsx';

// The list that replaces the normal message list while a GTD tab is active. Backed by
// the same sections store as the GTD sidebar (one source of truth, live via
// gtd_sections_updated) so Waiting (watch+delegated) and unified both work without
// driving selectedFolder into a label folder. Its rows carry the same triage
// affordances as the inbox and sidebar rows — hover quick actions and a right-click
// menu — via the shared useGtdTriage hook, so this surface is full triage, not browse-only.
export default function GtdTabList() {
  const { t } = useTranslation();
  const activeGtdTab = useStore(s => s.activeGtdTab);
  const gtdSections = useStore(s => s.gtdSections);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const selectedMid = useStore(selectSelectedMessageMid);
  const hoverQuickActions = useStore(s => s.hoverQuickActions);

  const { contextMenu, setContextMenu, handleGtdAction, openRow, rowActions } = useGtdTriage();

  const section = buildGtdDisplaySections(gtdSections).find(s => s.key === activeGtdTab);
  const threads = section?.threads || [];

  if (threads.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
        {t('gtd.tabEmpty')}
      </div>
    );
  }

  // Roomy `list` variant of the shared GTD row, with the hover cluster gated on the
  // same preference that gates it on the inbox rows this surface replaces.
  return (
    <div>
      {threads.map(thread => (
        <GtdTriageRow
          key={thread.id ?? thread.message_id}
          thread={thread}
          sectionKey={activeGtdTab}
          variant="list"
          selected={isSelectedRow(thread, selectedMessageId, selectedMid)}
          onOpen={() => openRow(thread)}
          rowActions={rowActions}
          hoverQuickActions={hoverQuickActions}
          t={t}
        />
      ))}

      {/* Portal to body, mirroring GtdSidebarContent's menu: this list has no transform
          of its own, but the portal keeps the menu's position:fixed math consistent
          across both GTD row surfaces. */}
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
    </div>
  );
}
