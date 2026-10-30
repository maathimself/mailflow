import { useEffect, useMemo, useRef } from 'react';
import { createHoverPrefetch, createPrefetchBudget, PREFETCH_PER_MINUTE, PREFETCH_PER_MINUTE_GMAIL } from '../utils/hoverPrefetch.js';
import { bodyCache, prefetchBodyOnHover } from '../utils/bodyCache.js';
import { folderRole } from '../utils/folderDisplay.js';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';

const isGmail = account => account?.oauth_provider === 'google'
  || /(^|\.)(gmail|googlemail)\.com$/i.test(account?.imap_host || '');
// Providers the server never prefetches for (imapManager.prefetchBodyVerdict): Yahoo's single
// pooled connection, which a click would queue behind, and PurelyMail, whose body fetches each
// open a login. Skipped here too, so not even one request is spent on learning it.
const neverPrefetched = account => /(^|\.)(yahoo|ymail)\.com$|purelymail\.com$/i.test(account?.imap_host || '');

// Each account's prefetch budget and pauses, kept across list remounts for the session, and
// emptied when the user changes or the app locks.
export const prefetchBudget = createPrefetchBudget();
let budgetFor = useStore.getState().user?.id ?? null;
useStore.subscribe((state) => {
  const user = state.user?.id ?? null;
  if (user !== budgetFor || state.isLocked) {
    budgetFor = user;
    prefetchBudget.clear();
  }
});

function findMessage(state, id) {
  const lists = [state.messages, state.searchResults, ...Object.values(state.threadMessages || {})];
  for (const list of lists) {
    const found = Array.isArray(list) ? list.find(m => m?.id === id) : null;
    if (found) return found;
  }
  return null;
}

// What the prefetcher needs to know of a row, or null when it is not worth a prefetch: a body
// cached or open already; a draft (opening one opens the composer); an account the server never
// prefetches for.
export function describeRow(state, id) {
  if (!id || bodyCache.has(id) || id === state.selectedMessageId) return null;
  const message = findMessage(state, id);
  if (!message) return null;
  const account = (state.accounts || []).find(a => a.id === message.account_id);
  const folder = (state.folders?.[message.account_id] || []).find(f => f.path === message.folder) || { path: message.folder };
  if (neverPrefetched(account)) return null;
  if ((message.flags || []).includes('\\Draft') || folderRole(folder, account?.folder_mappings) === 'drafts') return null;
  return { account: message.account_id, perMinute: isGmail(account) ? PREFETCH_PER_MINUTE_GMAIL : PREFETCH_PER_MINUTE };
}

// The list's handlers for loading a row's body while a mouse rests on it (#677, see
// utils/hoverPrefetch.js). Rows are found by their data-msgid, so the rows themselves need
// nothing. Off while `enabled` is false (a phone, selection mode).
//
// Only the pointer's own moves count. Scrolling the list under a parked pointer brings rows under
// it too, and browsers report that as the pointer entering them; a scroll cancels the wait instead,
// and until the pointer moves again nothing starts.
export function useHoverPrefetch({ enabled }) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const parked = useRef(null); // where the pointer was when the list last scrolled
  const last = useRef(null);
  const prefetcher = useMemo(() => createHoverPrefetch({
    prefetch: prefetchBodyOnHover,
    describe: id => describeRow(useStore.getState(), id),
    busy: () => api.bodyRequestsInFlight() > 0,
    settled: () => api.bodyRequestsSettled(),
    budget: prefetchBudget,
  }), []);
  useEffect(() => {
    if (!enabled) prefetcher.leave();
  }, [enabled, prefetcher]);
  useEffect(() => () => prefetcher.leave(), [prefetcher]);
  return useMemo(() => ({
    onPointerMove: (e) => {
      if (!enabledRef.current || e.pointerType !== 'mouse') return;
      const at = { x: e.clientX, y: e.clientY };
      last.current = at;
      if (parked.current) {
        if (parked.current.x === at.x && parked.current.y === at.y) return;
        parked.current = null;
      }
      const row = e.target?.closest?.('[data-msgid]');
      if (row) prefetcher.enter(row.getAttribute('data-msgid'));
      else prefetcher.leave();
    },
    onScroll: () => {
      parked.current = last.current || { x: NaN, y: NaN };
      prefetcher.leave();
    },
    onPointerLeave: () => {
      last.current = null;
      prefetcher.leave();
    },
  }), [prefetcher]);
}
