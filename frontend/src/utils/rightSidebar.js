export function clampRightSidebarWidth(value, { min = 200, max = 600, fallback = 296 } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}
