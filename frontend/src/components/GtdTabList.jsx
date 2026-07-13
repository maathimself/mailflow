import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageMid } from '../store/index.js';
import { api } from '../utils/api.js';
import {
  buildGtdDisplaySections, openDeepLinkMessage, isSelectedRow,
} from '../utils/gtd.js';
import GtdEntryRow from './GtdEntryRow.jsx';

// The browse list that replaces the normal message list while a GTD tab is
// active. Backed by the same sections store as the GTD sidebar (one source of truth,
// live via gtd_sections_updated) so Waiting (watch+delegated) and unified both
// work without driving selectedFolder into a label folder.
export default function GtdTabList() {
  const { t } = useTranslation();
  const activeGtdTab = useStore(s => s.activeGtdTab);
  const gtdSections = useStore(s => s.gtdSections);
  const setThreadMessages = useStore(s => s.setThreadMessages);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const selectedMid = useStore(selectSelectedMessageMid);
  const scheduleGtdSectionsFetch = useStore(s => s.scheduleGtdSectionsFetch);

  const section = buildGtdDisplaySections(gtdSections).find(s => s.key === activeGtdTab);
  const threads = section?.threads || [];

  const openRow = (thread) => {
    openDeepLinkMessage(thread.id, {
      getMessage: api.getMessage, getThread: api.getThread,
      setThreadMessages, setSelectedMessage,
      thread, onMiss: scheduleGtdSectionsFetch,
    });
  };

  if (threads.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
        {t('gtd.tabEmpty')}
      </div>
    );
  }

  // Roomy `list` variant of the shared GTD row — no hover cluster or context menu here
  // (this surface is browse-only; triage lives in the sidebar rows).
  return (
    <div>
      {threads.map(thread => (
        <GtdEntryRow
          key={thread.id ?? thread.message_id}
          thread={thread}
          sectionKey={activeGtdTab}
          variant="list"
          selected={isSelectedRow(thread, selectedMessageId, selectedMid)}
          onClick={() => openRow(thread)}
          t={t}
        />
      ))}
    </div>
  );
}
