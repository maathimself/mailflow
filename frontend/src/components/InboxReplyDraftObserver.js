import { useEffect } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { openReplyDraft, replyDraftScope } from '../utils/openReplyDraft.js';

export default function InboxReplyDraftObserver({ lookupDelayMs = 350 }) {
  const { messages, searchResults, searchQuery, selectedFolder, selectedAccountId,
    selectedMessageId, threadMessages, conversationMode, replyDraftRevision, autoOpenReplyDrafts, messagesRefreshToken } = useStore();
  const rows = searchQuery ? searchResults : messages;
  const ids = rows.filter(row => row.folder?.toUpperCase() === 'INBOX'
    && (!selectedAccountId || row.account_id === selectedAccountId)).map(row => row.id);
  const selected = [...rows, ...Object.values(threadMessages || {}).flat()].find(row => row.id === selectedMessageId);
  const selectedEligible = selected?.folder?.toUpperCase() === 'INBOX'
    && (!selectedAccountId || selected.account_id === selectedAccountId);
  const key = JSON.stringify(ids);
  const scope = replyDraftScope(useStore.getState());
  useEffect(() => {
    if (selectedFolder?.toUpperCase() !== 'INBOX') return;
    let active = true;
    const load = async () => {
      try {
        for (let start = 0; start < ids.length; start += 100) {
          const result = await api.getReplyDraftIndicators(ids.slice(start, start + 100), scope);
          if (!active) return;
          for (const [id, status] of Object.entries(result.indicators || {}))
            useStore.getState().setReplyDraftStatus(id, status, 'cached', replyDraftRevision);
        }
      } catch { /* Selected-message live lookup reports errors; batches are only hints. */ }
    };
    load();
    return () => { active = false; };
  }, [key, selectedFolder, selectedAccountId, conversationMode, replyDraftRevision, messagesRefreshToken]); // eslint-disable-line react-hooks/exhaustive-deps -- key captures the complete row identity list

  useEffect(() => {
    if (selectedFolder?.toUpperCase() !== 'INBOX' || !selectedEligible) return;
    let active = true;
    const load = async () => {
      try {
        const state = useStore.getState();
        const canOpen = autoOpenReplyDrafts && (!state.composing || state.composeData?.source === 'automaticReplyDraft');
        const result = await api.getReplyDraft(selectedMessageId, { ...scope, ...(canOpen ? { open: true } : {}) });
        const { draft } = result;
        if (!active) return;
        useStore.getState().setReplyDraftStatus(selectedMessageId,
          { exists: Boolean(draft), ...(draft ? { accountId: draft.account_id } : {}) }, 'live', replyDraftRevision);
        if (draft && canOpen) await openReplyDraft(selectedMessageId, { automatic: true,
          liveResult: result, liveScope: scope, liveRevision: replyDraftRevision });
      } catch (error) {
        if (active) useStore.getState().setReplyDraftStatus(selectedMessageId, { error: error.message }, 'live', replyDraftRevision);
      }
    };
    const timer = lookupDelayMs ? setTimeout(load, lookupDelayMs) : (load(), null);
    return () => { active = false; clearTimeout(timer); };
  }, [selectedMessageId, selectedEligible, selectedFolder, selectedAccountId, conversationMode, replyDraftRevision, autoOpenReplyDrafts, messagesRefreshToken, lookupDelayMs]); // eslint-disable-line react-hooks/exhaustive-deps -- scope changes invalidate replyDraftRevision; row-list changes only refresh cached hints

  useEffect(() => {
    const invalidate = () => useStore.getState().invalidateReplyDrafts();
    window.addEventListener('mailflow:refresh', invalidate);
    return () => window.removeEventListener('mailflow:refresh', invalidate);
  }, []);
  return null;
}
