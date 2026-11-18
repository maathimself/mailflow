import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { RESUME_RETRY_EVENT } from '../utils/resumeRefresh.js';

// How long a resync after the app resumes runs before the list says it is updating. Most finish
// well inside it, and a line that flashes on every unlock is noise.
export const RESUME_STATUS_DELAY_MS = 1000;

// A strip above the message list while a resync after the app resumes is catching up, or after it
// failed (#748): until then the list may show mail from before the phone slept. A failed resync
// keeps being retried on its own (utils/resumeRefresh.js); Retry asks for it at once.
export default function ResumeStatus() {
  const { t } = useTranslation();
  const resumeSync = useStore(s => s.resumeSync);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (resumeSync !== 'syncing') {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), RESUME_STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [resumeSync]);

  const failed = resumeSync === 'failed' || resumeSync === 'retrying';
  if (!failed && !(resumeSync === 'syncing' && slow)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '6px 16px', fontSize: 12, lineHeight: 1.4,
        color: 'var(--text-secondary)', background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {failed ? (
        <>
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>{t('messageList.resumeFailed')}</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(RESUME_RETRY_EVENT))}
            disabled={resumeSync === 'retrying'}
            style={{
              flexShrink: 0, fontSize: 12, padding: '3px 10px', borderRadius: 6,
              background: 'none', border: '1px solid var(--border)', color: 'var(--text-primary)',
              cursor: resumeSync === 'retrying' ? 'default' : 'pointer',
              opacity: resumeSync === 'retrying' ? 0.6 : 1,
            }}
          >
            {resumeSync === 'retrying' ? t('messageList.resumeRetrying') : t('common.retry')}
          </button>
        </>
      ) : (
        <>
          <span
            aria-hidden="true"
            style={{
              width: 10, height: 10, flexShrink: 0, boxSizing: 'border-box',
              border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }}
          />
          <span>{t('messageList.resumeUpdating')}</span>
        </>
      )}
    </div>
  );
}
