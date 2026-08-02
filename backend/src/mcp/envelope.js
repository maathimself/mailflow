export const TOTAL_COUNT_UNKNOWN = -1;

// msgvault wire timestamps are Go-marshaled RFC3339 with no sub-second part
// (SQLite second-precision sent_at; vector/stats.go formatTime uses
// time.RFC3339 explicitly). engineAdapter's toISO emits Date.toISOString()
// milliseconds — an internal convention REST shares — so the MCP layer
// re-formats at emission instead of touching engineAdapter (Wave D's file).
// TODO(seam): fold into engineAdapter.toISO if it ever becomes wire-final.
export function toRFC3339(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(/\.\d+(?=(?:Z|[+-]\d\d:\d\d)$)/, '');
}

// Re-shape one MessageSummary for the wire: today only sent_at needs
// re-formatting. Non-mutating; tolerates partial summaries from tests.
export function wireSummary(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  if (typeof summary.sent_at !== 'string' || !summary.sent_at) return summary;
  return { ...summary, sent_at: toRFC3339(summary.sent_at) };
}

export function newPaginatedResponse(data, total, offset) {
  const d = data || [];
  return { data: d, total, returned: d.length, offset, has_more: offset + d.length < total };
}

export function newPaginatedResponseNoTotal(data, offset, hasMore) {
  const d = data || [];
  return { data: d, total: TOTAL_COUNT_UNKNOWN, returned: d.length, offset, has_more: hasMore };
}
