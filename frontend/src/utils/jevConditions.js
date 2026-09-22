export function normalizeJevConditions(conditions) {
  return conditions.map(condition => condition.field === 'jev' && condition.threshold === undefined
    ? { ...condition, threshold: 0.8 }
    : condition);
}
