import { clockSkewMs, formatSendAt } from './scheduleTimes.js';

// The composer's side of scheduled send (#543, design 2.2 and 2.3): the Scheduled view, the
// create key, the edit hold and what the server's refusals mean to the user.
//
// Scheduled edit mode. The Scheduled view opens a message by opening the composer with the
// fields of GET /api/mail/scheduled/:id's spec, as a reopened message has them (accountId,
// aliasId, to, cc, bcc, subject, body, quotedBody, quotedBodyHtml, signature, priority, inReplyTo,
// references and spec.compose), plus
//   scheduled: { id, version, sendAt, timeZone, attachments: [{ index, filename, size, contentType, kind }] }
// and optionally scheduled.editToken when it took the hold itself. The composer then holds the
// message while it is open, renews the lease, saves with PUT under that version, and releases the
// hold when it closes without saving.

// The Scheduled view's id (design 5.2): with no account selected it cannot be a folder's.
export const SCHEDULED_VIEW = '__scheduled__';

// The hold lasts 30 minutes on the server (EDIT_LEASE); it is renewed well before.
export const HOLD_RENEW_MS = 5 * 60_000;

export const isScheduledEdit = composeData => Boolean(composeData?.scheduled?.id);

// The view the schedule toast's View opens: MessageList renders ScheduledList for it (design 5.2).
// With `id` it highlights that message there (a toast's Open, a notification link).
export function openScheduledView(store, id = null) {
  if (id) store.getState().setScheduledHighlight?.(id);
  store.getState().setSelectedAccount(null, SCHEDULED_VIEW);
}

// A v4 UUID for the create's clientKey, which the server requires to be one. crypto.randomUUID
// needs a secure context, and MailFlow also runs over plain HTTP on a LAN; getRandomValues does not.
export function newClientKey(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const b = cryptoApi.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The field an Undo toast of one scheduled message carries its id in (the schedule toast, Send
// now's, Delete's). Any other action on that message in this tab dismisses the toast: its Undo
// would put back something the user has changed since (supersedeUndo).
export const UNDO_FOR = 'scheduledUndoFor';
export function supersedeUndo(store, id) {
  store.getState().dismissUndoNotifications?.(n => n[UNDO_FOR] === id);
}

// How long the "Scheduled for ..." toast offers Undo. Cancel works for minutes on the server; the
// toast is what bounds it, so Undo is there exactly as long as the toast is.
export const SCHEDULE_UNDO_MS = 10_000;
// A scheduled message whose time is less than this away is handed back paused when a hold is
// given back on its own (the message changed meanwhile, or the composer closed during a release):
// released as scheduled it would be due at once, and go out unconfirmed.
export const DUE_MARGIN_MS = 60_000;
// Send now goes 10 s later (SEND_NOW_DELAY_MS in routes/scheduled.js), the window of its Undo.
export const SEND_NOW_DELAY_MS = 10_000;

// What is left of Send now's window once its answer is in, counted from when the request went
// out rather than from the server's undoUntil, so a wrong clock here cannot shorten or stretch it.
export function sendNowUndoMs(startedAt, now = Date.now()) {
  return Math.max(0, Math.min(SEND_NOW_DELAY_MS, SEND_NOW_DELAY_MS - (now - startedAt)));
}

// Runs `fn` once: a second call (a double click on Undo while its toast fades out) does nothing
// and resolves what the first did.
export function once(fn) {
  let result = null;
  return (...args) => {
    if (!result) result = Promise.resolve().then(() => fn(...args));
    return result;
  };
}

// Undo of a schedule (design 2.2): cancel the message, then reopen the composer with it, as undo
// send does. Cancel is idempotent, so a failure that is not the server's refusal (a lost answer,
// a dropped connection) is tried once more. A refusal is said in the server's words. One that
// still fails points to the Scheduled view, where a cancelled message can be restored for
// minutes. Resolves whether the message came back.
export async function undoSchedule({ id, restoreData }, { cancel, reopen, notify, openView, t }) {
  let err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await cancel(id);
      reopen(restoreData);
      return true;
    } catch (e) {
      err = e;
      if (e?.status === 409 || e?.status === 404) break;
    }
  }
  if (err?.status === 409 || err?.status === 404) {
    notify({ type: 'error', title: t('compose.scheduleSend.undoFailed'), body: err.message, allowWrap: true, persistent: true });
  } else {
    notify({
      type: 'error', title: t('compose.scheduleSend.undoFailedOpen'), body: err?.message || '', allowWrap: true, persistent: true,
      ...(openView ? { onAction: openView } : {}),
    });
  }
  return false;
}

// Undo of Send now: puts back what Send now replaced. Says when the message goes now, that it is
// paused because its time passed meanwhile, that it is back as it was (paused or failed), or why it
// could not be undone (too late, or opened in another window).
export async function undoSendNow({ id, undoToken, subject }, { undo, notify, t, locale }) {
  try {
    const r = await undo(id, undoToken);
    // Its time passed meanwhile: the server put it back paused, as scheduled it would go at once.
    if (r?.status === 'paused' && r.pauseReason === 'user') notify({ title: t('compose.scheduleSend.edit.keptPaused'), body: subject });
    else if (r?.status === 'scheduled') notify({ title: t('compose.scheduleSend.scheduledFor', { when: formatSendAt(r.sendAt, locale) }), body: subject });
    else notify({ title: t('compose.scheduleSend.sendNow.undone'), body: subject });
    return true;
  } catch (err) {
    const body = err?.code === 'held_elsewhere' ? t('compose.scheduleSend.errors.heldElsewhere')
      : err?.code === 'undo_expired' ? t('scheduled.errors.undoExpired') : err.message;
    notify({ type: 'error', title: t('compose.scheduleSend.sendNow.undoFailed'), body, allowWrap: true, persistent: true });
    return false;
  }
}

// What the server answers when an action could send a message that may already have gone out,
// or one a restored backup paused: it asks first, and the same request with confirm: true goes on.
export const needsConfirmation = err => err?.code === 'confirm_uncertain' || err?.code === 'confirm_restored';

// The edit hold of one scheduled message while the composer has it open. `api` is
// api.scheduled. start() takes the hold (or renews the one the opener took), renewals keep it
// every HOLD_RENEW_MS, check() renews it at once (the message changed elsewhere, or the page is
// seen again), settle() ends it after a save or an unschedule (the server cleared it),
// handBack() releases it and resolves once the server took it back (throwing, and still holding
// it, when a request failed on the way), and release() hands it back without waiting when the
// composer closes. `onLost(err)` is told when a renewal finds the message is no longer this
// composer's. `isDue()` says whether the message's time has passed, or is about to: a hold given
// back on its own (the message changed meanwhile) then leaves it paused, as one that fell due
// while open is never sent unconfirmed.
export function createEditHold({ id, version, editToken = null }, {
  api, onLost = () => {}, isDue = () => false, schedule = setTimeout, unschedule = clearTimeout, renewMs = HOLD_RENEW_MS,
}) {
  let token = editToken;
  let state = 'starting'; // 'held' | 'releasing' | 'lost' | 'done'
  let statusBefore = null;
  let timer = null;
  let renewing = null;
  let renewAgain = false;
  // Set when the composer closes while a handBack is out: it must not come back to life.
  let closing = false;
  // What the handBack out asked for, and whether the page's last release already went.
  let releasingPaused = false;
  let finalSent = false;
  const finalRelease = (pause) => {
    if (finalSent) return;
    finalSent = true;
    api.releaseOnUnload?.(id, token, pause ? { keepPaused: true } : undefined);
  };

  const conflict = () => Object.assign(new Error('version_conflict'), { code: 'version_conflict' });
  const arm = () => { unschedule(timer); timer = schedule(renew, renewMs); };
  // The content this composer opened is not the server's any more, so it gives the message back at
  // once rather than leave it held, unsendable, until the lease lapses.
  const giveBack = () => {
    const keepPaused = statusBefore === 'scheduled' && isDue();
    (keepPaused ? api.release(id, token, { keepPaused: true }) : api.release(id, token)).catch(() => {});
  };
  const lose = (err, { release = false } = {}) => {
    if (state !== 'held') return;
    state = 'lost';
    unschedule(timer);
    if (release) giveBack();
    onLost(err);
  };

  // One renewal at a time. A check() while one is out runs another after it, as the answer out
  // may predate the change that asked for it.
  function renew() {
    if (state !== 'held') return Promise.resolve();
    if (renewing) { renewAgain = true; return renewing; }
    renewing = renewOnce().finally(() => {
      renewing = null;
      if (!renewAgain) return;
      renewAgain = false;
      if (state === 'held') { unschedule(timer); renew(); }
    });
    return renewing;
  }
  async function renewOnce() {
    try {
      const r = await api.hold(id, token);
      // Saved, released or closed meanwhile: the server refuses a renewal of a hold that ended,
      // so nothing was taken back, and there is nothing to do.
      if (state !== 'held') return;
      if (r.version !== version) return lose(conflict(), { release: true });
      arm();
    } catch (err) {
      if (state !== 'held') return;
      // The server says the message is not this composer's to edit (taken over after a lapsed
      // lease, being sent, deleted).
      if (err?.status === 404 || err?.status === 409) return lose(Object.assign(err, { code: err.code || 'hold_lost' }));
      // Offline or a server error: the lease has 25 more minutes, so the next renewal tries again.
      arm();
    }
  }

  return {
    // `takeover` takes the message from the window that holds it, when the user asked to edit it
    // here instead (after a held_elsewhere); start() can be called again for that.
    async start({ takeover = false } = {}) {
      if (state === 'lost') state = 'starting';
      try {
        const r = await (takeover ? api.hold(id, null, { takeover: true }) : api.hold(id, token));
        token = r.editToken;
        statusBefore = r.statusBefore ?? null;
        // Closed while the hold was being taken: hand it straight back.
        if (state === 'done') {
          api.release(id, token).catch(() => {});
          return { ok: false, closed: true };
        }
        // A newer version than the one opened: given back at once, nothing to save over.
        if (r.version !== version) {
          state = 'held';
          lose(conflict(), { release: true });
          return { ok: false, stale: true, error: conflict() };
        }
        state = 'held';
        arm();
        return { ok: true, version: r.version, statusBefore };
      } catch (err) {
        if (state !== 'done') state = 'lost';
        return { ok: false, error: err };
      }
    },
    token: () => token,
    isHeld: () => state === 'held',
    // Renews now rather than at the next timer, so a takeover, a delete or a send elsewhere is
    // noticed when it happens rather than up to HOLD_RENEW_MS later.
    check() {
      if (state !== 'held') return Promise.resolve();
      unschedule(timer);
      return renew();
    },
    statusBefore: () => statusBefore,
    // The server said this composer no longer holds it (hold_lost on a save).
    markLost() { if (state === 'held') { state = 'lost'; unschedule(timer); } },
    settle() { state = 'done'; unschedule(timer); },
    // Releases it and waits for the server. Only a release that went through ends the hold: one
    // that failed on the way leaves it held and renewed, so the user can try again; one the
    // server refused (409, 404) means the hold was already gone.
    async handBack({ keepPaused = false } = {}) {
      if (state !== 'held') throw Object.assign(new Error('hold_lost'), { code: 'hold_lost', status: 409 });
      state = 'releasing';
      releasingPaused = keepPaused;
      unschedule(timer);
      try {
        await (keepPaused ? api.release(id, token, { keepPaused: true }) : api.release(id, token));
        state = 'done';
      } catch (err) {
        if (err?.status === 404 || err?.status === 409) state = 'lost';
        else if (state === 'releasing' && !closing) { state = 'held'; arm(); }
        else {
          // The composer closed while this was out: one last try that outlives it, and no more
          // renewals. Failing that too, the lease lapses on its own.
          state = 'done';
          finalRelease(keepPaused || (statusBefore === 'scheduled' && isDue()));
        }
        throw err;
      }
    },
    release({ unloading = false } = {}) {
      // A handBack is out: it finishes the job (or its failure does), not this. A page going away
      // may not see it finish, so its keepalive release goes now, as the handBack asked.
      if (state === 'releasing') {
        closing = true;
        if (unloading) finalRelease(releasingPaused || (statusBefore === 'scheduled' && isDue()));
        return Promise.resolve();
      }
      const held = state === 'held';
      state = 'done';
      unschedule(timer);
      if (!held || !token) return Promise.resolve();
      if (unloading) { api.releaseOnUnload?.(id, token); return Promise.resolve(); }
      return api.release(id, token).then(() => {}, () => {});
    },
  };
}

// The server's limits and refusals that say the same whatever the message, in the user's language.
const LIMIT_TEXT = {
  too_many: 'compose.scheduleSend.errors.tooMany',
  too_much_storage: 'compose.scheduleSend.errors.tooMuchStorage',
  rate_limited: 'compose.scheduleSend.errors.rateLimited',
  payload_too_large: 'compose.scheduleSend.errors.payloadTooLarge',
  decrypt_failed: 'scheduled.reason.decryptFailed',
  sending_now: 'scheduled.errors.aboutToSend',
};
export const limitErrorText = (err, t) => (LIMIT_TEXT[err?.code] ? t(LIMIT_TEXT[err.code]) : null);

// What to tell the user about a refused schedule or save, in their language: a limit, a lost
// hold, a newer version, and a too_soon or too_far, with the server's time when a wrong clock on
// this device explains it.
export function scheduleErrorText(err, t, { now = Date.now(), locale } = {}) {
  const limit = limitErrorText(err, t);
  if (limit) return limit;
  switch (err?.code) {
    case 'hold_lost':
      // Gone (deleted for good) or deleted with Undo elsewhere, or sent from another window, is
      // said as such; anything else is another window that holds it now.
      if (err.status === 404 || err.state === 'cancelled') return t('compose.scheduleSend.errors.deletedElsewhere');
      if (err.state === 'sending' || err.state === 'sent') return t('compose.scheduleSend.errors.sentElsewhere');
      return t('compose.scheduleSend.errors.holdLost');
    case 'held_elsewhere':
      return t('compose.scheduleSend.errors.heldElsewhere');
    case 'version_conflict':
      return t('compose.scheduleSend.errors.versionConflict');
    case 'too_soon':
    case 'too_far': {
      const said = t(err.code === 'too_soon' ? 'compose.scheduleSend.errors.tooSoon' : 'compose.scheduleSend.errors.tooFar');
      const skew = clockSkewMs(err.serverNow, now);
      if (skew == null) return said;
      const minutes = Math.max(1, Math.round(Math.abs(skew) / 60_000));
      const time = formatSendAt(err.serverNow, locale, new Date(now));
      const note = skew > 0
        ? t('compose.scheduleSend.errors.clockBehind', { minutes, time })
        : t('compose.scheduleSend.errors.clockAhead', { minutes, time });
      return `${said} ${note}`;
    }
    default:
      return err?.message || t('compose.scheduleSend.errors.failed');
  }
}
