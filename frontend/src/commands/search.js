function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

function fuzzyScore(candidate, query) {
  const text = normalize(candidate);
  const needle = normalize(query);
  if (!needle) return 0;
  if (text === needle) return 1000;
  if (text.startsWith(needle)) return 900 - (text.length - needle.length);
  if (text.includes(needle)) return 800 - text.indexOf(needle);
  const distance = editDistance(text, needle);
  const limit = Math.max(1, Math.floor(Math.max(text.length, needle.length) * 0.34));
  return distance <= limit ? 600 - (distance * 40) - Math.abs(text.length - needle.length) : null;
}

export function rankCommands(commands, query, context) {
  return commands.map((command, index) => {
    const title = context.translate(command.titleKey, command.params);
    const aliases = command.aliasKeys.map(key => ({ key, value: context.translate(key, command.params) }));
    const candidates = [{ key: null, value: title }, ...aliases]
      .map(item => ({ ...item, fuzzy: fuzzyScore(item.value, query) }))
      .filter(item => item.fuzzy != null)
      .sort((a, b) => b.fuzzy - a.fuzzy);
    if (query.trim() && !candidates.length) return null;
    const match = candidates[0] || { key: null, value: title, fuzzy: 0 };
    const boost = command.rank.boost ? command.rank.boost(context) : 0;
    return {
      command,
      title,
      matchedAlias: match.key ? match.value : null,
      matchedAliasKey: match.key,
      score: match.fuzzy + command.rank.base + boost,
      index,
    };
  }).filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(result => ({
      command: result.command,
      title: result.title,
      matchedAlias: result.matchedAlias,
      matchedAliasKey: result.matchedAliasKey,
      score: result.score,
    }));
}
