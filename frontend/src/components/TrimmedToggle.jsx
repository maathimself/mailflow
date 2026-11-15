import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// A plain-text body's trailing quoted history behind a "•••" toggle (the Gmail layout), as the
// frame's document does it for HTML (utils/quotedHistory.js). `light`: on the white card a body
// shown in its original colors gets, in the frame's light colors.
export default function TrimmedToggle({ children, light = false }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = open ? t('message.hideTrimmed') : t('message.showTrimmed');
  return (
    <details className="mail-trimmed-text" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary title={title} aria-label={title} style={{
        display: 'inline-block', listStyle: 'none', cursor: 'pointer', margin: '8px 0',
        padding: '0 6px', height: 12, lineHeight: '6px', borderRadius: 6, fontSize: 12, letterSpacing: 1,
        background: light ? '#e8eaed' : 'var(--bg-tertiary)', color: light ? '#5f6368' : 'var(--text-secondary)',
      }}>•••</summary>
      {children}
    </details>
  );
}
