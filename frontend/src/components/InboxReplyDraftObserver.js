import { useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { savedDraftToComposeData } from '../utils/openSavedDraft.js';

// All selection paths (list clicks, j/k, pane arrows, swipes, initial selection) update the
// same store key. Keep lookup here so a delayed response cannot open the wrong draft.
export default function InboxReplyDraftObserver({ lookupDelayMs = 350 }) {
  const state = useStore();
  const { selectedMessageId, selectedFolder, selectedAccountId } = state;
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  const selected = pool.find(m => m.id === selectedMessageId)
    || Object.values(state.threadMessages).flat().find(m => m.id === selectedMessageId);
  const selectable = Boolean(selectedMessageId && selectedFolder === 'INBOX' && selected?.folder === 'INBOX'
    && (!selectedAccountId || selected.account_id === selectedAccountId));
  const generation = useRef(0);

  useEffect(() => {
    const token = ++generation.current;
    const generationRef = generation;
    const current = () => token === generation.current
      && useStore.getState().selectedMessageId === selectedMessageId
      && useStore.getState().selectedFolder === selectedFolder
      && useStore.getState().selectedAccountId === selectedAccountId;
    if (!selectable) return;

    const run = async () => {
      try {
        const { draft } = await api.getReplyDraft(selectedMessageId);
        if (!current()) return;
        let now = useStore.getState();
        if (!draft) {
          if (now.composing && now.composeData?.source === 'inboxReplyDraft') {
            if (now.prepareComposeSwitch && !(await now.prepareComposeSwitch())) return;
            if (current()) useStore.getState().closeCompose();
          }
          return;
        }
        if (now.composing && now.composeData?.source !== 'inboxReplyDraft') return;
        const persistedKey = `${draft.account_id}:${draft.folder}:${draft.uid}`;
        if (now.composing && now.composeData?.persistedKey === persistedKey) return;
        const body = await api.getMessageBody(draft.id);
        if (!current()) return;
        now = useStore.getState();
        if (now.composing && now.composeData?.source !== 'inboxReplyDraft') return;
        if (now.composing && now.prepareComposeSwitch && !(await now.prepareComposeSwitch())) return;
        if (!current()) return;
        now = useStore.getState();
        if (now.composing && now.composeData?.source !== 'inboxReplyDraft') return;
        now.openCompose({ ...savedDraftToComposeData(draft, body, now.accounts),
          source: 'inboxReplyDraft', sourceSelectionId: selectedMessageId });
      } catch (err) {
        if (current()) useStore.getState().addNotification({
          title: 'Could not check reply drafts', body: err.message });
      }
    };
    // A lookup opens a fresh IMAP session to avoid frozen pooled mailbox views. Wait for
    // rapid j/k or arrow navigation to settle so discarded selections cost no logins.
    const timer = lookupDelayMs > 0 ? setTimeout(run, lookupDelayMs) : null;
    if (!timer) run();
    return () => { if (timer) clearTimeout(timer); generationRef.current++; };
  }, [selectedMessageId, selectedFolder, selectedAccountId, selectable, lookupDelayMs]);

  return null;
}
