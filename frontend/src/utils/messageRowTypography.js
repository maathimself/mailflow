const TERTIARY_TEXT = { color: 'var(--text-tertiary)' };

const UNREAD_TYPOGRAPHY = {
  sender: { color: 'var(--text-primary)', fontWeight: 600 },
  subject: { color: 'var(--text-primary)', fontWeight: 500 },
  preview: TERTIARY_TEXT,
  date: TERTIARY_TEXT,
};

const READ_TYPOGRAPHY = {
  sender: { color: 'var(--text-secondary)', fontWeight: 400 },
  subject: { color: 'var(--text-secondary)', fontWeight: 400 },
  preview: TERTIARY_TEXT,
  date: TERTIARY_TEXT,
};

export function resolveMessageRowTypography(isRead) {
  return isRead ? READ_TYPOGRAPHY : UNREAD_TYPOGRAPHY;
}
