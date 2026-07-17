export const GTD_SIDEBAR_PREVIEW_LIMITS = Object.freeze({
  todo: 6,
  waiting: 6,
  reference: 3,
  someday: 3,
});

export function getGtdSidebarPreview(section, expanded) {
  const allThreads = Array.isArray(section?.threads) ? section.threads : [];
  const limit = GTD_SIDEBAR_PREVIEW_LIMITS[section?.key] ?? 6;
  const available = allThreads.length;
  const total = Math.max(Number(section?.total) || 0, available);

  return {
    threads: expanded ? allThreads : allThreads.slice(0, limit),
    limit,
    available,
    total,
    expandable: available > limit,
    bounded: total > available,
  };
}
