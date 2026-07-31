export const EMAIL_BODY_APPEARANCE_AUTO = 'auto';
export const EMAIL_BODY_APPEARANCE_ORIGINAL = 'original';

export function normalizeEmailBodyAppearance(value) {
  return value === EMAIL_BODY_APPEARANCE_ORIGINAL
    ? EMAIL_BODY_APPEARANCE_ORIGINAL
    : EMAIL_BODY_APPEARANCE_AUTO;
}

export function emailBodyAppearanceToggleLabel(desiredMode) {
  return normalizeEmailBodyAppearance(desiredMode) === EMAIL_BODY_APPEARANCE_ORIGINAL
    ? 'message.matchThemeColors'
    : 'message.showOriginalColors';
}
