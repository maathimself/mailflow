import { useState, useRef, useEffect } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';

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

// Parse a normalizeTo string (or raw value) into an array of chips
function parseChips(val) {
  const str = typeof val === 'string' ? val : normalizeTo(val);
  return str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];
}

export default function ComposeModal() {
  const { closeCompose, composeData, accounts, addNotification } = useStore();
  const isMobile = useMobile();

  const isReply = !!(composeData?.isReply || composeData?.isReplyAll);
  const isForward = !!composeData?.isForward;

  const [toChips, setToChips] = useState(() => parseChips(composeData?.to));
  const [toInput, setToInput] = useState('');
  const [ccChips, setCcChips] = useState(() => parseChips(composeData?.cc));
  const [ccInput, setCcInput] = useState('');
  const [subject, setSubject] = useState(() => composeData?.subject || '');
  const [body, setBody] = useState(() => composeData?.body || '');
  const [quotedBody, setQuotedBody] = useState(() => composeData?.quotedBody || '');
  const [showCc, setShowCc] = useState(() => !!(composeData?.cc?.length));

  // Re-apply on mount — guards against Zustand state not being ready during first render
  useEffect(() => {
    if (composeData?.to?.length) setToChips(parseChips(composeData.to));
    if (composeData?.cc?.length) { setCcChips(parseChips(composeData.cc)); setShowCc(true); }
    if (composeData?.subject) setSubject(composeData.subject);
    if (composeData?.body !== undefined) setBody(composeData.body);
    if (composeData?.quotedBody !== undefined) setQuotedBody(composeData.quotedBody);
  }, []);

  const initialFromValue = () => {
    if (composeData?.aliasId && composeData?.accountId) {
      return `alias:${composeData.aliasId}:${composeData.accountId}`;
    }
    const acctId = composeData?.accountId || accounts[0]?.id || '';
    return acctId ? `account:${acctId}` : '';
  };
  const [fromValue, setFromValue] = useState(initialFromValue);

  const resolveFrom = (val) => {
    if (!val) return { accountId: '', aliasId: null };
    if (val.startsWith('alias:')) {
      const parts = val.split(':');
      return { aliasId: parts[1], accountId: parts[2] };
    }
    return { accountId: val.replace('account:', ''), aliasId: null };
  };

  const fromResolved = resolveFrom(fromValue);
  const fromAccount = accounts.find(a => a.id === fromResolved.accountId);
  const fromAlias = fromResolved.aliasId
    ? fromAccount?.aliases?.find(al => al.id === fromResolved.aliasId)
    : null;
  const fromSignature = fromAlias
    ? (fromAlias.signature !== null && fromAlias.signature !== undefined ? fromAlias.signature : fromAccount?.signature || null)
    : (fromAccount?.signature || null);

  const [replyAll, setReplyAll] = useState(() => !!composeData?.isReplyAll);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [showReplyType, setShowReplyType] = useState(false);
  const replyTypeRef = useRef(null);
  const textareaRef = useRef(null);

  // Track visible viewport height so the compose panel shrinks with the keyboard
  const [viewportHeight, setViewportHeight] = useState(
    () => window.visualViewport?.height ?? window.innerHeight
  );
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setViewportHeight(vv.height);
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [isMobile]);

  // Position cursor at top for replies/forwards
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

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    const { accountId, aliasId } = resolveFrom(fromValue);
    const toFinal = [...toChips, ...(toInput.trim() ? [toInput.trim()] : [])];
    if (!toFinal.length || !accountId) return;
    setSending(true);
    setError('');
    try {
      await api.post('/mail/send', {
        accountId,
        ...(aliasId ? { aliasId } : {}),
        to: toFinal,
        cc: [...ccChips, ...(ccInput.trim() ? [ccInput.trim()] : [])],
        subject,
        body: body + (quotedBody || ''),
        inReplyTo: composeData?.inReplyTo,
        references: composeData?.references || undefined,
      });
      closeCompose();
      addNotification({ title: 'Message sent', body: subject || '(no subject)' });
    } catch (err) {
      setError(err.message);
      setSending(false);
    }
  };

  const modeLabel = isReply
    ? (replyAll ? 'Reply All' : 'Reply')
    : isForward ? 'Forward' : 'New Message';

  const sendSpinner = (
    <div style={{
      width: 14, height: 14, borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)', borderTopColor: 'white',
      animation: 'spin 0.7s linear infinite', flexShrink: 0,
    }} />
  );
  const sendIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );

  // ── Mobile full-screen compose ──────────────────────────────────────────────
  if (isMobile) {
    const switchToReply = () => {
      setToChips(parseChips(composeData?.originalFrom || composeData?.to));
      setToInput(''); setCcChips([]); setCcInput(''); setShowCc(false);
      setReplyAll(false);
      setShowReplyType(false);
    };
    const switchToReplyAll = () => {
      setToChips(parseChips(composeData?.originalFrom || composeData?.to));
      setToInput('');
      const allRecipients = parseChips(composeData?.allRecipients || []);
      if (allRecipients.length) { setCcChips(allRecipients); setCcInput(''); setShowCc(true); }
      setReplyAll(true);
      setShowReplyType(false);
    };

    const fieldStyle = {
      display: 'flex', alignItems: 'center',
      borderBottom: '1px solid var(--border-subtle)',
      padding: '0 16px', flexShrink: 0,
    };
    const labelStyle = {
      fontSize: 13, color: 'var(--text-tertiary)',
      width: 60, flexShrink: 0,
    };
    const mobileInputStyle = {
      flex: 1, padding: '12px 0',
      background: 'transparent', border: 'none',
      color: 'var(--text-primary)', fontSize: 16,
      outline: 'none', width: '100%',
    };

    return (
      <div
        onKeyDown={handleKeyDown}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0,
          height: viewportHeight,
          paddingTop: 'var(--sat)',
          background: 'var(--bg-secondary)',
          zIndex: 2000,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '10px 14px', flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <button
            onClick={closeCompose}
            style={{
              background: 'none', border: 'none',
              color: 'var(--accent)', fontSize: 16,
              cursor: 'pointer', padding: '4px 0', minWidth: 60,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Cancel
          </button>
          <span style={{
            flex: 1, textAlign: 'center',
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)',
          }}>
            {modeLabel}
          </span>
          <button
            onClick={handleSend}
            disabled={sending || (toChips.length === 0 && !toInput.trim())}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              minWidth: 60, justifyContent: 'flex-end',
              background: 'none', border: 'none',
              color: sending || (toChips.length === 0 && !toInput.trim()) ? 'var(--text-tertiary)' : 'var(--accent)',
              fontSize: 16, fontWeight: 600,
              cursor: sending || (toChips.length === 0 && !toInput.trim()) ? 'default' : 'pointer',
              padding: '4px 0',
              WebkitTapHighlightColor: 'transparent',
              transition: 'color 0.15s',
            }}
          >
            {sending ? sendSpinner : 'Send'}
          </button>
        </div>

        {/* Reply/Reply All toggle */}
        {isReply && (
          <div style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}>
            {[
              { label: 'Reply', active: !replyAll, onTap: switchToReply },
              { label: 'Reply All', active: replyAll, onTap: switchToReplyAll },
            ].map(({ label, active, onTap }) => (
              <button
                key={label}
                onClick={onTap}
                style={{
                  flex: 1, padding: '9px 0',
                  background: 'none', border: 'none',
                  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                  color: active ? 'var(--accent)' : 'var(--text-tertiary)',
                  fontSize: 13, fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  transition: 'color 0.15s, border-color 0.15s',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Scrollable fields + body */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/* From */}
          <div style={fieldStyle}>
            <span style={labelStyle}>From</span>
            <select
              value={fromValue}
              onChange={e => setFromValue(e.target.value)}
              style={{ ...mobileInputStyle, cursor: 'pointer' }}
            >
              {accounts.map(a => {
                const aliases = a.aliases || [];
                if (!aliases.length) {
                  return (
                    <option key={a.id} value={`account:${a.id}`} style={{ background: 'var(--bg-tertiary)' }}>
                      {a.name} &lt;{a.email_address}&gt;
                    </option>
                  );
                }
                return (
                  <optgroup key={a.id} label={a.name} style={{ background: 'var(--bg-tertiary)' }}>
                    <option value={`account:${a.id}`} style={{ background: 'var(--bg-tertiary)' }}>
                      {a.name} &lt;{a.email_address}&gt;
                    </option>
                    {aliases.map(alias => (
                      <option key={alias.id} value={`alias:${alias.id}:${a.id}`} style={{ background: 'var(--bg-tertiary)' }}>
                        {alias.name} &lt;{alias.email}&gt;
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>

          {/* To */}
          <div style={{ ...fieldStyle, alignItems: 'flex-start', paddingTop: 4 }}>
            <span style={{ ...labelStyle, paddingTop: 10 }}>To</span>
            <ChipInput
              chips={toChips} onChipsChange={setToChips}
              value={toInput} onChange={setToInput}
              placeholder="recipient@example.com"
              autoFocus={!isReply && !isForward}
              inputStyle={mobileInputStyle}
            />
            {!showCc && (
              <button
                onClick={() => setShowCc(true)}
                style={{
                  background: 'none', border: 'none',
                  color: 'var(--text-tertiary)', cursor: 'pointer',
                  fontSize: 13, padding: '10px 0 4px 8px',
                  WebkitTapHighlightColor: 'transparent',
                  flexShrink: 0,
                }}
              >
                Cc
              </button>
            )}
          </div>

          {/* Cc */}
          {showCc && (
            <div style={{ ...fieldStyle, alignItems: 'flex-start', paddingTop: 4 }}>
              <span style={{ ...labelStyle, paddingTop: 10 }}>Cc</span>
              <ChipInput
                chips={ccChips} onChipsChange={setCcChips}
                value={ccInput} onChange={setCcInput}
                placeholder="cc@example.com"
                inputStyle={mobileInputStyle}
              />
            </div>
          )}

          {/* Subject */}
          <div style={fieldStyle}>
            <span style={labelStyle}>Subject</span>
            <input
              type="text" value={subject} onChange={e => setSubject(e.target.value)}
              placeholder="Subject"
              style={mobileInputStyle}
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
              flex: 1, minHeight: 200,
              padding: '14px 16px',
              background: 'transparent', border: 'none',
              color: 'var(--text-primary)', fontSize: 16, lineHeight: 1.7,
              resize: 'none', outline: 'none',
              fontFamily: 'var(--font-sans, DM Sans, sans-serif)',
              boxSizing: 'border-box', whiteSpace: 'pre-wrap',
            }}
          />

          {/* Signature */}
          {fromSignature && (
            <div style={{ padding: '0 16px 12px', borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '8px 0 6px', userSelect: 'none' }}>
                -- signature
              </div>
              <div
                style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ __html: fromSignature }}
              />
            </div>
          )}

          {/* Quoted body */}
          {quotedBody && (
            <textarea
              value={quotedBody}
              onChange={e => setQuotedBody(e.target.value)}
              style={{
                width: '100%', minHeight: 120,
                padding: '10px 16px',
                background: 'transparent',
                border: 'none', borderTop: '1px solid var(--border-subtle)',
                color: 'var(--text-tertiary)', fontSize: 13, lineHeight: 1.6,
                resize: 'none', outline: 'none',
                fontFamily: 'var(--font-sans, DM Sans, sans-serif)',
                boxSizing: 'border-box', whiteSpace: 'pre-wrap',
              }}
            />
          )}

          {/* Error */}
          {error && (
            <div style={{
              padding: '10px 16px', flexShrink: 0,
              fontSize: 13, color: 'var(--red)',
            }}>
              {error}
            </div>
          )}

          {/* Bottom safe area spacer */}
          <div style={{ height: 'var(--sab)', flexShrink: 0 }} />
        </div>
      </div>
    );
  }

  // ── Desktop compose (unchanged) ─────────────────────────────────────────────

  const inputStyle = {
    width: '100%', padding: '8px 12px',
    background: 'var(--bg-tertiary)', border: 'none',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)', fontSize: 13,
    outline: 'none',
  };

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
    <div
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed', bottom: 0, right: 24,
        width: 540, maxWidth: 'calc(100vw - 48px)',
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderBottom: 'none', borderRadius: '10px 10px 0 0',
        boxShadow: 'var(--shadow-modal)',
        zIndex: 1000, display: 'flex', flexDirection: 'column',
        maxHeight: '75vh',
        animation: 'compose-enter 0.18s ease',
      }}
    >
      {/* Title bar */}
      <div style={{
        padding: '10px 14px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
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
              {replyAll ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/>
                  <path d="M22 18v-2a4 4 0 00-4-4H7"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/>
                </svg>
              )}
              {replyAll ? 'Reply All' : 'Reply'}
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
                  active={!replyAll}
                  onClick={() => {
                    setToChips(parseChips(composeData?.originalFrom || composeData?.to));
                    setToInput(''); setCcChips([]); setCcInput(''); setShowCc(false);
                    setReplyAll(false);
                    setShowReplyType(false);
                  }}
                />
                <DropItem
                  icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>}
                  label="Reply All"
                  active={replyAll}
                  onClick={() => {
                    setToChips(parseChips(composeData?.originalFrom || composeData?.to));
                    setToInput('');
                    const allRecipients = parseChips(composeData?.allRecipients || []);
                    if (allRecipients.length) { setCcChips(allRecipients); setCcInput(''); setShowCc(true); }
                    setReplyAll(true);
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
            value={fromValue}
            onChange={e => setFromValue(e.target.value)}
            style={{ flex: 1, padding: '8px 4px', background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: 13, outline: 'none', cursor: 'pointer' }}
          >
            {accounts.map(a => {
              const aliases = a.aliases || [];
              if (!aliases.length) {
                return (
                  <option key={a.id} value={`account:${a.id}`} style={{ background: 'var(--bg-tertiary)' }}>
                    {a.name} &lt;{a.email_address}&gt;
                  </option>
                );
              }
              return (
                <optgroup key={a.id} label={a.name} style={{ background: 'var(--bg-tertiary)' }}>
                  <option value={`account:${a.id}`} style={{ background: 'var(--bg-tertiary)' }}>
                    {a.name} &lt;{a.email_address}&gt;
                  </option>
                  {aliases.map(alias => (
                    <option key={alias.id} value={`alias:${alias.id}:${a.id}`} style={{ background: 'var(--bg-tertiary)' }}>
                      {alias.name} &lt;{alias.email}&gt;
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>

        {/* To */}
        <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0, paddingTop: 9 }}>To</span>
          <ChipInput
            chips={toChips} onChipsChange={setToChips}
            value={toInput} onChange={setToInput}
            placeholder="recipient@example.com"
            autoFocus={!isReply && !isForward}
            inputStyle={{ ...inputStyle, borderBottom: 'none', padding: '6px 4px' }}
          />
          {!showCc && (
            <button onClick={() => setShowCc(true)} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '9px 0 4px 6px', flexShrink: 0 }}>
              Cc
            </button>
          )}
        </div>

        {/* Cc */}
        {showCc && (
          <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0, paddingTop: 9 }}>Cc</span>
            <ChipInput
              chips={ccChips} onChipsChange={setCcChips}
              value={ccInput} onChange={setCcInput}
              placeholder="cc@example.com"
              inputStyle={{ ...inputStyle, borderBottom: 'none', padding: '6px 4px' }}
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
            width: '100%', minHeight: isReply || isForward ? 120 : 200,
            padding: '12px 14px',
            background: 'transparent', border: 'none',
            color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.7,
            resize: 'vertical', outline: 'none',
            fontFamily: 'var(--font-sans, DM Sans, sans-serif)',
            boxSizing: 'border-box', whiteSpace: 'pre-wrap',
          }}
        />

        {fromSignature ? (
          <div style={{ padding: '0 14px 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, userSelect: 'none' }}>
              -- signature
            </div>
            <div
              style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: fromSignature }}
            />
          </div>
        ) : null}

        {quotedBody ? (
          <textarea
            value={quotedBody}
            onChange={e => setQuotedBody(e.target.value)}
            style={{
              width: '100%', minHeight: 120,
              padding: '10px 14px',
              background: 'transparent',
              borderTop: '1px solid var(--border-subtle)', borderBottom: 'none',
              borderLeft: 'none', borderRight: 'none',
              color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.6,
              resize: 'vertical', outline: 'none',
              fontFamily: 'var(--font-sans, DM Sans, sans-serif)',
              boxSizing: 'border-box', whiteSpace: 'pre-wrap',
            }}
          />
        ) : null}
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 14px', borderTop: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <button
          onClick={handleSend}
          disabled={sending || (toChips.length === 0 && !toInput.trim())}
          title={sending ? undefined : 'Send (Ctrl+Enter)'}
          style={{
            padding: '8px 20px', background: 'var(--accent)',
            border: 'none', borderRadius: 7, color: 'white',
            fontSize: 13, fontWeight: 500,
            cursor: sending || (toChips.length === 0 && !toInput.trim()) ? 'not-allowed' : 'pointer',
            opacity: sending || (toChips.length === 0 && !toInput.trim()) ? 0.6 : 1,
            display: 'flex', alignItems: 'center', gap: 6,
            transition: 'opacity 0.15s',
          }}
        >
          {sending ? sendSpinner : sendIcon}
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

function ChipInput({ chips, onChipsChange, value, onChange, placeholder, autoFocus, inputStyle }) {
  const commitInput = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onChipsChange([...chips, trimmed]);
    onChange('');
  };

  const handleKeyDown = (e) => {
    if (e.key === ',' || e.key === 'Enter' || e.key === 'Tab') {
      if (value.trim()) { e.preventDefault(); commitInput(); }
    } else if (e.key === 'Backspace' && !value && chips.length) {
      onChipsChange(chips.slice(0, -1));
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1, alignItems: 'center', padding: '5px 0', minWidth: 0 }}>
      {chips.map((chip, i) => (
        <span key={i} style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          background: 'var(--accent-dim)', color: 'var(--accent)',
          borderRadius: 6, padding: '2px 6px 2px 8px', fontSize: 12,
          maxWidth: 220,
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{chip}</span>
          <button
            type="button"
            onClick={() => onChipsChange(chips.filter((_, j) => j !== i))}
            style={{ background: 'none', border: 'none', padding: '0 0 0 2px', cursor: 'pointer', color: 'var(--accent)', display: 'flex', lineHeight: 1, flexShrink: 0 }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </span>
      ))}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitInput}
        placeholder={chips.length ? '' : placeholder}
        autoFocus={autoFocus}
        style={{ ...inputStyle, flex: '1 1 80px', minWidth: 80 }}
      />
    </div>
  );
}

