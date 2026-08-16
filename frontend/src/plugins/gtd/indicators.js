const STATE_ORDER = ['todo', 'watch', 'delegated', 'reference', 'someday'];
const WAITING_STATES = new Set(['watch', 'delegated']);
const STALE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const COLORS = {
  todo: '#4A9EDD',
  watch: '#D9B430',
  delegated: '#E08B3D',
  reference: '#7157d9',
  someday: 'var(--text-tertiary)',
};

const BACKGROUNDS = {
  todo: 'rgba(74,158,221,0.16)',
  watch: 'rgba(217,180,48,0.15)',
  delegated: 'rgba(224,139,61,0.15)',
  reference: 'rgba(113,87,217,0.16)',
  someday: 'rgba(139,139,155,0.16)',
};

function wholeDays(date, now) {
  const timestamp = new Date(date).getTime();
  if (!date || !Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / DAY_MS));
}

export function buildInboxGtdIndicators(metadata, t, now = Date.now()) {
  if (!Array.isArray(metadata?.states)) return [];
  const states = new Set(metadata.states.filter(state => STATE_ORDER.includes(state)));
  return STATE_ORDER.filter(state => states.has(state)).map(state => {
    const waiting = WAITING_STATES.has(state);
    const days = waiting ? wholeDays(metadata.dates?.[state] ?? metadata.date, now) : null;
    const stale = waiting && days != null && days > STALE_DAYS;
    return {
      state,
      label: waiting && days != null ? `⏱ ${days}d` : t(`gtd.state.${state}`),
      stale,
      color: stale ? '#ff9b9b' : COLORS[state],
      background: stale ? 'rgba(248,113,113,.16)' : BACKGROUNDS[state],
    };
  });
}
