import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api.js';

const REFRESH_MS = 5 * 60_000;
const PENDING_POLL_MS = 4000;
const PENDING_POLL_MAX = 45;

// Accounts, calendars and the events of one date range. Refetches on a range change, when the
// window gets focus, every five minutes, and while an account has not finished its first sync.
export function useCalendarData({ active, from, to }) {
  const [accounts, setAccounts] = useState(null);
  const [calendars, setCalendars] = useState([]);
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState(null);
  const rangeRef = useRef({ from, to });
  const seq = useRef(0);
  const polls = useRef(0);
  rangeRef.current = { from, to };

  const loadMeta = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([api.calendar.accounts(), api.calendar.calendars()]);
      setAccounts(a);
      setCalendars(c);
      setError(null);
      return a;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  const loadEvents = useCallback(async () => {
    const { from: f, to: t } = rangeRef.current;
    const mine = ++seq.current;
    setEventsLoading(true);
    try {
      const res = await api.calendar.events(f, t);
      if (mine !== seq.current) return;
      setEvents(res.events || []);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(err.message);
    } finally {
      if (mine === seq.current) setEventsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadMeta(), loadEvents()]);
  }, [loadMeta, loadEvents]);

  const hasAccounts = Boolean(accounts && accounts.length);

  useEffect(() => { if (active && accounts === null) loadMeta(); }, [active, accounts, loadMeta]);
  useEffect(() => { if (active && hasAccounts) loadEvents(); }, [active, hasAccounts, from, to, loadEvents]);

  useEffect(() => {
    if (!active) return undefined;
    const onFocus = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      clearInterval(timer);
    };
  }, [active, refresh]);

  const pending = Boolean(accounts?.some(a => !a.lastSyncAt && !a.lastError));
  useEffect(() => {
    if (!active || !pending) { polls.current = 0; return undefined; }
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > PENDING_POLL_MAX) { clearInterval(timer); return; }
      refresh();
    }, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [active, pending, refresh]);

  return { accounts, setAccounts, calendars, setCalendars, events, eventsLoading, error, setError, loadMeta, loadEvents, refresh, pending };
}
