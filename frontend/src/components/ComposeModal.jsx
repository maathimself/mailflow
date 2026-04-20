import { useState, useRef, useEffect } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

// Normalize address arrays to comma-separated string
// Handles: plain strings, {email} objects, {name, email} objects
function normalizeTo(arr) {
  if (!arr || !arr.length) return '';
  return arr.map(t => {
    if (typeof t === 'string') return t;
    if (t && (t.email || t.name)) {
      if (t.name && t.email) return `${t.name} <${t.email}>`;
      return t.email || t.name;
    }
    return '';
  }).filter(Boolean).join(', ');
}



export default function ComposeModal() {
  const { closeCompose, composeData, accounts } = useStore();

  const [to, setTo] = useState(() => normalizeTo(composeData?.to) || '');
  const [cc, setCc] = useState(() => normalizeTo(composeData?.cc) || '');
  const [subject, setSubject] = useState(() => composeData?.subject || '');
  const [body, setBody] = useState(() => composeData?.body || '');
  const [showCc, setShowCc] = useState(() => !!(composeData?.cc?.length));

  // Re-apply on mount — guards against Zustand state not being ready during first render
  useEffect(() => {
    if (composeData?.to?.length) {
      const val = normalizeTo(composeData.to);
      if (val) setTo(val);
    }
    if (composeData?.cc?.length) { setCc(normalizeTo(composeData.cc)); setShowCc(true); }
    if (composeData?.subject) setSubject(composeData.subject);
    if (composeData?.body !== undefined) setBody(composeData.body);
  }, []);
  const [fromAccountId, setFromAccountId] = useState(
    composeData?.accountId || accounts[0]?.id || ''
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [showReplyType, setShowReplyType] = useState(false);
  const replyTypeRef = useRef(null);
  const textareaRef = useRef(null);

  const isReply = !!(composeData?.isReply || composeData?.isReplyAll);
  const isForward = !!composeData?.isForward;

  // Position cursor at top of textarea for replies
  useEffect(() => {
    if ((isReply || isForward) && textareaRef.current) {
      textareaRef.current.setSelectionRange(0, 0);
      textareaRef.current.focus();
    }
  }, []);

  // Close reply type dropdown on outside click
  useEffect(() => {
    if (!showReplyType) return;
    const handler = (e) => {
      if (replyTypeRef.current && !replyTypeRef.current.contains(e.target)) {
        setShowReplyType(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showReplyType]);

  const handleSend = async () => {
    if (!to.trim() || !fromAccountId) return;
    setSending(true);
    setError('');
    try {
      await api.post('/mail/send', {
        accountId: fromAccountId,
        to: to.split(',').map(s => s.trim()).filter(Boolean),
        cc: cc ? cc.split(',').map(s => s.trim()).filter(Boolean) : [],
        subject,
        body,
        inReplyTo: composeData?.inReplyTo,
      });
      closeCompose();
    } catch (err) {
      setError(err.message);
      setSending(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '8px 12px',
    background: 'var(--bg-tertiary)', border: 'none',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)', fontSize: 13,
    outline: 'none',
  };

  const modeLabel = isReply
    ? (composeData?.isReplyAll ? 'Reply All' : 'Reply')
    : isForward ? 'Forward' : 'New Message';

  if (minimized) {
    return (
      <div
        onClick={() => setMinimized(false)}
        style={{
          position: 'fixed', bottom: 0, right: 24,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderBottom: 'none', borderRadius: '8px 8px 0 0',
          padding: '10px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
          boxShadow: '0 -4px 20px rgba(0,0,0,0.3)', zIndex: 1000,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
        {subject || modeLabel}
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', bottom: 0, right: 24,
      width: 540, maxWidth: 'calc(100vw - 48px)',
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderBottom: 'none', borderRadius: '10px 10px 0 0',
      boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
      zIndex: 1000, display: 'flex', flexDirection: 'column',
      maxHeight: '75vh',
    }}>
      {/* Title bar */}
      <div style={{
        padding: '10px 14px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        {/* Reply type switcher */}
        {isReply ? (
          <div ref={replyTypeRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowReplyType(!showReplyType)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'none', border: 'none', padding: '2px 6px',
                color: 'var(--text-primary)', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, borderRadius: 5,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              {composeData?.isReplyAll ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/>
                  <path d="M22 18v-2a4 4 0 00-4-4H7"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/>
                </svg>
              )}
              {composeData?.isReplyAll ? 'Reply All' : 'Reply'}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {showReplyType && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 8, overflow: 'hidden', zIndex: 10,
                boxShadow: '0 4px 20px rgba(0,0,0,0.3)', minWidth: 160,
              }}>
                <DropItem
                  icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>}
                  label="Reply"
                  active={!composeData?.isReplyAll}
                  onClick={() => {
                    // Switch to reply — reset to just sender
                    setTo(normalizeTo(composeData?.originalFrom || composeData?.to) || '');
                    setCc('');
                    setShowCc(false);
                    composeData.isReplyAll = false;
                    setShowReplyType(false);
                  }}
                />
                <DropItem
                  icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>}
                  label="Reply All"
                  active={!!composeData?.isReplyAll}
                  onClick={() => {
                    // Switch to reply all — add original recipients to cc
                    setTo(normalizeTo(composeData?.originalFrom || composeData?.to) || '');
                    const allRecipients = normalizeTo(composeData?.allRecipients || []);
                    if (allRecipients) { setCc(allRecipients); setShowCc(true); }
                    composeData.isReplyAll = true;
                    setShowReplyType(false);
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {modeLabel}
          </span>
        )}

        <div style={{ display: 'flex', gap: 4 }}>
          <TitleBtn onClick={() => setMinimized(true)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </TitleBtn>
          <TitleBtn onClick={closeCompose} danger>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </TitleBtn>
        </div>
      </div>

      {/* Fields */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {/* From */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>From</span>
          <select
            value={fromAccountId}
            onChange={e => setFromAccountId(e.target.value)}
            style={{ flex: 1, padding: '8px 4px', background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: 13, outline: 'none', cursor: 'pointer' }}
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id} style={{ background: 'var(--bg-tertiary)' }}>
                {a.name} &lt;{a.email_address}&gt;
              </option>
            ))}
          </select>
        </div>

        {/* To */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>To</span>
          <input
            type="text" value={to} onChange={e => setTo(e.target.value)}
            placeholder="recipient@example.com"
            style={{ flex: 1, ...inputStyle, borderBottom: 'none', padding: '8px 4px' }}
            autoFocus={!isReply && !isForward}
          />
          {!showCc && (
            <button onClick={() => setShowCc(true)} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '4px 6px' }}>
              Cc
            </button>
          )}
        </div>

        {/* Cc */}
        {showCc && (
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>Cc</span>
            <input
              type="text" value={cc} onChange={e => setCc(e.target.value)}
              placeholder="cc@example.com"
              style={{ flex: 1, ...inputStyle, borderBottom: 'none', padding: '8px 4px' }}
            />
          </div>
        )}

        {/* Subject */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>Subject</span>
          <input
            type="text" value={subject} onChange={e => setSubject(e.target.value)}
            placeholder="Subject"
            style={{ flex: 1, ...inputStyle, borderBottom: 'none', padding: '8px 4px' }}
          />
        </div>

        {/* Body */}
        <textarea
          ref={textareaRef}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Write your message…"
          autoFocus={isReply || isForward}
          style={{
            width: '100%', minHeight: isReply || isForward ? 260 : 200,
            padding: '12px 14px',
            background: 'transparent', border: 'none',
            color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.7,
            resize: 'vertical', outline: 'none',
            fontFamily: 'var(--font-sans, DM Sans, sans-serif)',
            boxSizing: 'border-box', whiteSpace: 'pre-wrap',
          }}
        />
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 14px', borderTop: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <button
          onClick={handleSend}
          disabled={sending || !to.trim()}
          style={{
            padding: '8px 20px', background: 'var(--accent)',
            border: 'none', borderRadius: 7, color: 'white',
            fontSize: 13, fontWeight: 500,
            cursor: sending || !to.trim() ? 'not-allowed' : 'pointer',
            opacity: sending || !to.trim() ? 0.6 : 1,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
          {sending ? 'Sending…' : 'Send'}
        </button>

        {error && <span style={{ fontSize: 12, color: 'var(--red)', flex: 1 }}>{error}</span>}

        <button onClick={closeCompose} style={{
          marginLeft: 'auto', background: 'none', border: 'none',
          color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12, padding: '4px 8px',
        }}>
          Discard
        </button>
      </div>
    </div>
  );
}

function TitleBtn({ children, onClick, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? (danger ? 'var(--red)' : 'var(--bg-hover)') : 'var(--bg-elevated)',
        border: 'none', borderRadius: 4, padding: '4px',
        color: hov && danger ? 'white' : 'var(--text-tertiary)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function DropItem({ icon, label, active, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 14px', cursor: 'pointer',
        background: hov ? 'var(--bg-hover)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-primary)',
        fontSize: 13, transition: 'background 0.08s',
      }}
    >
      <span style={{ color: active ? 'var(--accent)' : 'var(--text-tertiary)' }}>{icon}</span>
      {label}
      {active && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" style={{ marginLeft: 'auto' }}>
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
    </div>
  );
}
