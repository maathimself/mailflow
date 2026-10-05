// The browser's half of undo send. The server holds the message for the undo window
// (backend/src/services/sendHold.js) and delivers it whether or not this tab is still open. Until
// then this offers Undo; afterwards it asks the server what happened and reports it the way an
// immediate send would have been reported.

export const UNDO_SEND_SECONDS = 10;

// Delivery can outlast the window by a lot (a large attachment over a slow server), so a send
// still in progress is asked about again rather than given up on straight away.
export const POLL_INTERVAL_MS = 2000;
export const GIVE_UP_AFTER_MS = 5 * 60_000;

// What the server can say once a held send is over, one way or another.
const OUTCOMES = new Set(['sent', 'cancelled', 'failed', 'lost', 'unknown']);

// How long Undo stays on screen: what the server said was left of the window when it answered.
// Counting from the response rather than from the request keeps a slow upload from eating into the
// window, and taking the server's figure rather than its sendAt keeps a wrong client clock out.
export function undoWindowMs(remainingMs) {
  const full = UNDO_SEND_SECONDS * 1000;
  return Number.isFinite(remainingMs) ? Math.max(0, Math.min(full, remainingMs)) : full;
}

// Opens the composer with `data`. With another message already open it waits for that one to
// close instead, because the store holds a single composer and replacing its data would mix the
// two messages. A wait is dropped if the user signs out meanwhile: the message is theirs, not
// the next user's. Returns whether it opened now.
export function reopenCompose(store, data) {
  if (!store.getState().composing) {
    store.getState().openCompose(data);
    return true;
  }
  const owner = store.getState().user?.id;
  const unsubscribe = store.subscribe(state => {
    if (state.user?.id !== owner) { unsubscribe(); return; }
    if (state.composing) return;
    unsubscribe();
    state.openCompose(data);
  });
  return false;
}

// Follows one held send. `restore(error)` reopens the message (returning whether it opened now),
// `onSent(result)` reports a delivered one. `onOwnerChange(stop)` calls stop when the signed-in
// user changes and returns an unsubscribe: a sign-out in the same tab does not reload the page, and
// the next user must not be asked about, or handed back, the previous user's message. Returns the
// undo action for the Undo button.
export function trackHeldSend({ pendingId, undoMs, subject }, { restore, onSent }, deps) {
  const { getStatus, cancel, notify, dismissUndo, t, onOwnerChange, schedule = setTimeout, unschedule = clearTimeout, now = Date.now } = deps;
  const deadline = now() + undoMs + GIVE_UP_AFTER_MS;
  let settled = false;
  let undoing = false;
  let nextPoll = null;
  let unwatch = () => {};
  const abandon = () => {
    if (settled) return;
    settled = true;
    unschedule(nextPoll);
    unwatch();
    dismissUndo();
  };
  unwatch = onOwnerChange?.(abandon) ?? (() => {});

  const reopen = (error) => (restore(error) ? subject : t('compose.undoSend.reopenLater'));

  // Every outcome goes through here once, whichever of the poll and the Undo button learns it
  // first. Returns false while the send is still pending or under way.
  const settle = (status) => {
    if (settled) return true;
    if (!OUTCOMES.has(status?.status)) return false;
    settled = true;
    unschedule(nextPoll);
    unwatch();
    dismissUndo();
    switch (status.status) {
      case 'sent':
        onSent(status.result || { ok: true });
        break;
      case 'cancelled':
        // The message reopening is the confirmation. A toast would sit on the composer's footer,
        // where the user is about to click, so it appears only when the reopening has to wait.
        if (!restore()) notify({ title: t('compose.undoSend.undone'), body: t('compose.undoSend.reopenLater') });
        break;
      case 'failed':
      case 'lost': {
        const error = status.status === 'lost' ? t('compose.undoSend.lost') : status.error;
        notify({ type: 'error', title: t('compose.undoSend.notSent'), body: reopen(error) });
        break;
      }
      default: // 'unknown'
        // Neither outcome can be assumed: reopening by itself could lead to a second copy, and
        // saying nothing could hide a message that never left. The user checks Sent and decides.
        notify({
          type: 'error', persistent: true,
          title: t('compose.undoSend.unknown'), body: t('compose.undoSend.unknownBody'),
          actionLabel: t('compose.undoSend.reopen'),
          onAction: () => { if (!restore()) notify({ title: t('compose.undoSend.reopen'), body: t('compose.undoSend.reopenLater') }); },
        });
    }
    return true;
  };

  const poll = async () => {
    if (settled) return;
    let status = null;
    try { status = await getStatus(pendingId); } catch { /* offline for a moment: ask again */ }
    if (settle(status)) return;
    if (now() >= deadline) { settle({ status: 'unknown' }); return; }
    nextPoll = schedule(poll, POLL_INTERVAL_MS);
  };
  nextPoll = schedule(poll, undoMs + 1000);

  return async function undo() {
    if (settled || undoing) return;
    undoing = true;
    try {
      const result = await cancel(pendingId);
      // Settled while the cancel was on its way: by a sign-out, whose next user must not see
      // this message's subject, or by the poll, which has already said what happened.
      if (settled) return;
      if (result?.cancelled) { settle({ status: 'cancelled' }); return; }
      if (result?.status === 'sending' || result?.status === 'sent') {
        notify({ title: t('compose.undoSend.tooLate'), body: subject });
      }
      settle(result);
    } catch {
      if (settled) return;
      notify({ type: 'error', title: t('compose.undoSend.undoFailed'), body: subject });
    } finally {
      undoing = false;
    }
  };
}
