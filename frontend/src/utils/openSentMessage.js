// "View" on the toast after a send: opens the account's Sent folder and then the message itself,
// once its Sent copy is in the list. The copy can take a few seconds to be listed (a server that
// saves it on its own is only seen at the next sync), so the list is watched for a while. Moving
// to another folder, or opening another message, ends the wait.

export const SENT_COPY_WAIT_MS = 30_000;

export function openSentMessage(store, { accountId, folder, messageId }, { wait = SENT_COPY_WAIT_MS, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  store.getState().setSelectedAccount(accountId, folder);
  if (!messageId) return;
  let unsubscribe = () => {};
  let timer = null;
  const stop = () => { unsubscribe(); unschedule(timer); };
  const check = state => {
    if (state.selectedAccountId !== accountId || state.selectedFolder !== folder || state.selectedMessageId) {
      stop();
      return;
    }
    const row = state.messages.find(m => m.message_id === messageId);
    if (!row) return;
    stop();
    state.setSelectedMessage(row.id);
  };
  unsubscribe = store.subscribe(check);
  timer = schedule(stop, wait);
  check(store.getState());
}
