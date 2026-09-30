import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// A password field with an eye button that shows what has been typed, so a long password can
// be checked before it is submitted. Takes every prop an <input> does; `type` is its own.
export default function PasswordInput({ style, className, ...props }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const label = visible ? t('login.hidePassword') : t('login.showPassword');
  return (
    <div style={{ position: 'relative' }}>
      {/* mf-password-input hides Edge's own reveal button (index.css), which would sit next to this one. */}
      <input {...props} className={['mf-password-input', className].filter(Boolean).join(' ')}
        type={visible ? 'text' : 'password'} style={{ ...style, paddingRight: 42 }} />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        // Keeps the caret in the field when the eye is clicked with a mouse.
        onMouseDown={e => e.preventDefault()}
        aria-label={label}
        aria-pressed={visible}
        title={label}
        style={{
          position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 6,
          background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer',
          color: 'var(--text-tertiary)',
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {visible ? (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
              <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
              <path d="M14.12 14.12a3 3 0 11-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </>
          ) : (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
