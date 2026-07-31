const EMAIL_BODY_APPEARANCES = new Set(['auto', 'original']);

export function sanitizeEmailBodyAppearancePrefs(body = {}) {
  const value = body?.emailBodyAppearance;
  return {
    emailBodyAppearance: EMAIL_BODY_APPEARANCES.has(value) ? value : null,
  };
}
