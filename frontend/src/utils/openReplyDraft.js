import i18n from '../i18n.js';
import { api } from './api.js';
import { useStore } from '../store/index.js';
import { groupsMessageList } from './conversationMode.js';
import { savedDraftToComposeData } from './openSavedDraft.js';

let requestSequence = 0;
let manualRequest = 0;
export const replyDraftScope = state => ({ accountId: state.selectedAccountId || undefined,
  threaded: groupsMessageList(state.conversationMode) && !state.searchQuery });
const identity = draft => JSON.stringify([draft.account_id, draft.folder, draft.uid,
  draft.message_id, draft.uid_validity]);

export async function openReplyDraft(messageId, { automatic = false, liveResult, liveScope, liveRevision } = {}) {
  if (automatic && manualRequest) return false;
  const initial = useStore.getState();
  if (automatic && !initial.autoOpenReplyDrafts) return false;
  if (automatic && (initial.selectedMessageId !== messageId || initial.selectedFolder?.toUpperCase() !== 'INBOX')) return false;
  if (automatic && initial.composing && initial.composeData?.source !== 'automaticReplyDraft') return false;
  const scope = replyDraftScope(initial);
  if (automatic && liveResult && (liveScope?.accountId !== scope.accountId
    || liveScope?.threaded !== scope.threaded || liveRevision !== initial.replyDraftRevision)) return false;
  const sequence = ++requestSequence;
  if (!automatic) manualRequest = sequence;
  let revision = initial.replyDraftRevision;
  let ownerChanged = false;
  let invalidated = false;
  const unsubscribe = useStore.subscribe(state => {
    if (state.user?.id !== initial.user?.id) ownerChanged = true;
  });
  const ownsContext = () => {
    const state = useStore.getState();
    return !ownerChanged && state.user?.id === initial.user?.id
      && (!automatic || state.autoOpenReplyDrafts)
      && sequence === requestSequence && state.selectedFolder === initial.selectedFolder
      && state.selectedAccountId === initial.selectedAccountId && state.selectedMessageId === initial.selectedMessageId
      && state.conversationMode === initial.conversationMode && state.searchQuery === initial.searchQuery && state.composing === initial.composing
      && state.composeSession === initial.composeSession;
  };
  const current = () => ownsContext() && !invalidated && useStore.getState().replyDraftRevision === revision;
  const onDraftSaved = ({ before, after, session }) => {
    if (!ownsContext() || invalidated || before !== revision || after !== before + 1 || session !== initial.composeSession) {
      invalidated = true;
      return;
    }
    revision = after;
  };
  const notice = body => { if (current()) useStore.getState().addNotification({ title: i18n.t('messageList.replyDraft'), body }); };
  try {
    // The observer can supply the body it just validated with open=true. A save
    // still requires a new lookup below before handing off the current composer.
    let result = automatic && liveResult?.body ? liveResult
      : await api.getReplyDraft(messageId, { ...scope, open: true });
    if (!current()) return false;
    if (!result.draft) { useStore.getState().setReplyDraftStatus(messageId, { exists: false }, 'live', revision); notice(i18n.t('messageList.replyDraftUnavailable')); return false; }
    let data = savedDraftToComposeData(result.draft, result.body, useStore.getState().accounts);
    if (initial.composing && initial.composeData?.persistedKey === data.persistedKey) {
      if (!automatic) useStore.setState({ composeData: { ...useStore.getState().composeData, source: 'manualReplyDraft' } });
      return true;
    }
    if (initial.composing) {
      if (!initial.prepareComposeSwitch || !(await initial.prepareComposeSwitch({ onDraftSaved }))) {
        notice(i18n.t('messageList.replyDraftKeepCurrent')); return false;
      }
      if (!current()) return false;
      const expected = identity(result.draft);
      result = await api.getReplyDraft(messageId, { ...scope, open: true });
      if (!current()) return false;
      if (!result.draft || identity(result.draft) !== expected) { notice(i18n.t('messageList.replyDraftChanged')); return false; }
      data = savedDraftToComposeData(result.draft, result.body, useStore.getState().accounts);
    }
    if (!current()) return false;
    useStore.getState().setReplyDraftStatus(messageId, { exists: true, accountId: result.draft.account_id }, 'live', revision);
    return useStore.getState().openCompose({ ...data, source: automatic ? 'automaticReplyDraft' : 'manualReplyDraft', sourceSelectionId: messageId },
      { preparedSession: initial.composeSession });
  } catch (error) { notice(error.message); return false; }
  finally { unsubscribe(); if (manualRequest === sequence) manualRequest = 0; }
}
