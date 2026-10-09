import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { openReplyDraft, replyDraftScope } from '../utils/openReplyDraft.js';

export default function InboxReplyDraftObserver({ lookupDelayMs = 350 }) {
  const openingRef = useRef(null);
  const [retry, setRetry] = useState(0);
  const { messages, searchResults, searchQuery, selectedFolder, selectedAccountId,
    selectedMessageId, threadMessages, conversationMode, replyDraftRevision, replyDrafts, autoOpenReplyDrafts, messagesRefreshToken, user } = useStore();
  const rows = searchQuery ? searchResults : messages;
  const ids = [...new Set(rows.filter(row => row.folder?.toUpperCase() === 'INBOX'
    && (!selectedAccountId || row.account_id === selectedAccountId)).map(row => row.id))];
  const selected = [...rows, ...Object.values(threadMessages || {}).flat()].find(row => row.id === selectedMessageId);
  const selectedEligible = selected?.folder?.toUpperCase() === 'INBOX'
    && (!selectedAccountId || selected.account_id === selectedAccountId);
  const selectedHasDraft = replyDrafts[selectedMessageId]?.exists === true;
  if (selectedEligible && !ids.includes(selectedMessageId)) ids.push(selectedMessageId);
  const key = JSON.stringify(ids);
  const scope = replyDraftScope(useStore.getState());
  // A handoff's own save changes the revision. Only a new selection or lookup
  // scope needs another lookup when that handoff finishes.
  const requestKey = JSON.stringify([selectedMessageId, selectedEligible, selectedFolder, selectedAccountId,
    conversationMode, searchQuery, autoOpenReplyDrafts, messagesRefreshToken, user?.id]);
  const latestRequestKey = useRef(requestKey);
  latestRequestKey.current = requestKey;
  useEffect(() => {
    if (selectedFolder?.toUpperCase() !== 'INBOX') return;
    let active = true;
    const unsubscribe = useStore.subscribe(state => { if (state.user?.id !== user?.id) active = false; });
    const current = () => {
      const state = useStore.getState();
      return active && state.selectedFolder === selectedFolder && state.selectedAccountId === selectedAccountId
        && state.conversationMode === conversationMode && state.searchQuery === searchQuery
        && state.replyDraftRevision === replyDraftRevision;
    };
    const load = async () => {
      try {
        for (let start = 0; start < ids.length; start += 100) {
          const result = await api.getReplyDraftIndicators(ids.slice(start, start + 100), scope);
          if (!current()) return;
          for (const [id, status] of Object.entries(result.indicators || {}))
            useStore.getState().setReplyDraftStatus(id, status, 'cached', replyDraftRevision);
        }
      } catch { /* Synced indicators are hints; explicit opening reports lookup errors. */ }
    };
    load();
    return () => { active = false; unsubscribe(); };
  }, [key, selectedFolder, selectedAccountId, conversationMode, searchQuery, replyDraftRevision, messagesRefreshToken, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- key captures the complete row identity list

  useEffect(() => {
    const initial = useStore.getState();
    if (openingRef.current) {
      if (openingRef.current.requestKey !== requestKey) openingRef.current.retry = true;
      return;
    }
    if (!autoOpenReplyDrafts || selectedFolder?.toUpperCase() !== 'INBOX' || !selectedEligible || !selectedHasDraft
      || (initial.composing && initial.composeData?.source !== 'automaticReplyDraft')) return;
    let active = true;
    const unsubscribe = useStore.subscribe(state => { if (state.user?.id !== user?.id) active = false; });
    const current = () => {
      const state = useStore.getState();
      return active && state.autoOpenReplyDrafts && state.user?.id === user?.id
        && state.selectedMessageId === selectedMessageId && state.selectedFolder === selectedFolder
        && state.selectedAccountId === selectedAccountId && state.conversationMode === conversationMode
        && state.searchQuery === searchQuery
        && state.composeSession === initial.composeSession && state.composing === initial.composing
        && state.replyDraftRevision === replyDraftRevision;
    };
    const load = async () => {
      try {
        if (!current()) return;
        const result = await api.getReplyDraft(selectedMessageId, { ...scope, open: true });
        const { draft } = result;
        if (!current()) return;
        useStore.getState().setReplyDraftStatus(selectedMessageId,
          { exists: Boolean(draft), ...(draft ? { accountId: draft.account_id } : {}) }, 'live', replyDraftRevision);
        if (draft) {
          // A handoff save invalidates synced indicators. Its owning opener rechecks
          // identity itself; that invalidation must not start a competing opener.
          const handoff = { requestKey, retry: false };
          openingRef.current = handoff;
          let opened = false;
          try { opened = await openReplyDraft(selectedMessageId, { automatic: true,
            liveResult: result, liveScope: scope, liveRevision: replyDraftRevision }); }
          finally {
            openingRef.current = null;
            if (handoff.retry && (!opened || latestRequestKey.current !== requestKey)) setRetry(value => value + 1);
          }
        }
      } catch (error) {
        if (current()) useStore.getState().setReplyDraftStatus(selectedMessageId, { error: error.message }, 'live', replyDraftRevision);
      }
    };
    const timer = lookupDelayMs ? setTimeout(load, lookupDelayMs) : (load(), null);
    return () => { active = false; unsubscribe(); clearTimeout(timer); };
  }, [selectedMessageId, selectedEligible, selectedHasDraft, selectedFolder, selectedAccountId, conversationMode, searchQuery, replyDraftRevision, autoOpenReplyDrafts, messagesRefreshToken, lookupDelayMs, user?.id, retry]); // eslint-disable-line react-hooks/exhaustive-deps -- editor changes must not repeat this selection's live lookup

  useEffect(() => {
    const invalidate = () => useStore.getState().invalidateReplyDrafts();
    window.addEventListener('mailflow:refresh', invalidate);
    return () => window.removeEventListener('mailflow:refresh', invalidate);
  }, []);
  return null;
}
