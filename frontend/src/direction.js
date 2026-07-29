const DIRECTION_PREFERENCES = new Set(['auto', 'ltr', 'rtl']);

export function normalizeDirectionPreference(value) {
  return DIRECTION_PREFERENCES.has(value) ? value : 'auto';
}

export function normalizeLanguageTag(value) {
  const language = String(value || 'en').replaceAll('_', '-');
  const compact = language.match(/^([a-z]{2,3})([A-Z]{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}`;

  return language
    .split('-')
    .map((part, index) => index === 0 ? part.toLowerCase() : (part.length === 2 ? part.toUpperCase() : part))
    .join('-');
}

export function syncDocumentDirection(i18n, preference = 'auto', root = globalThis.document?.documentElement) {
  const mode = normalizeDirectionPreference(preference);
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const direction = mode === 'auto' ? i18n.dir(language) : mode;

  if (root) {
    root.setAttribute('lang', normalizeLanguageTag(language));
    root.setAttribute('dir', direction);
    root.dataset.interfaceDirection = mode;
  }

  return direction;
}

export function bindDocumentDirection(i18n, getPreference, root = globalThis.document?.documentElement) {
  const sync = () => syncDocumentDirection(i18n, getPreference(), root);
  sync();
  i18n.on('languageChanged', sync);
  return () => i18n.off('languageChanged', sync);
}
