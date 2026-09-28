// The UI language for a first visit, taken from the browser's preferred languages so the login
// screen already speaks the user's language. An explicit choice (Settings → Appearance →
// Language, kept in localStorage and in the account's preferences) always wins over this.

// Browser tags whose MailFlow locale is not simply their primary subtag. European Portuguese
// readers get Brazilian Portuguese rather than English; Traditional Chinese is skipped below
// rather than shown in Simplified.
const ALIASES = {
  pt: 'ptBR', 'pt-br': 'ptBR', 'pt-pt': 'ptBR',
  zh: 'zhCN', 'zh-cn': 'zhCN', 'zh-sg': 'zhCN', 'zh-hans': 'zhCN',
};

export function detectLanguage(preferred, supported, fallback = 'en') {
  const available = new Set(supported);
  for (const raw of preferred || []) {
    const tag = String(raw || '').trim().toLowerCase().replaceAll('_', '-');
    if (!tag) continue;
    if (/^zh-(tw|hk|mo|hant)\b/.test(tag)) continue;
    const base = tag.split('-')[0];
    for (const candidate of [ALIASES[tag], ALIASES[base], tag, base]) {
      if (candidate && available.has(candidate)) return candidate;
    }
  }
  return fallback;
}

// The BCP 47 tag for <html lang>, from a MailFlow locale code.
export function htmlLang(code) {
  return { ptBR: 'pt-BR', zhCN: 'zh-CN' }[code] || code;
}
