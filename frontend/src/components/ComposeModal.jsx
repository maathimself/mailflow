import { useState, useRef, useEffect, useCallback, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TextStyle, Color as TiptapColor, FontFamily } from '@tiptap/extension-text-style';
import { TextAlign } from '@tiptap/extension-text-align';
import Picker from '@emoji-mart/react';
import emojiData from '@emoji-mart/data';

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

// Parse a normalizeTo string (or raw value) into an array of chips.
// Splits on commas that are not inside quoted strings ("...") or angle brackets (<...>),
// so display names like "Smith, John <j@example.com>" are kept intact.
function parseChips(val) {
  const str = typeof val === 'string' ? val : normalizeTo(val);
  if (!str) return [];
  const parts = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && !inAngle) {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '<' && !inQuote) {
      inAngle = true;
      current += ch;
    } else if (ch === '>' && !inQuote) {
      inAngle = false;
      current += ch;
    } else if (ch === ',' && !inQuote && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

export default function ComposeModal() {
  const { t } = useTranslation();
  const { closeCompose, composeData, accounts, addNotification, setSelectedAccount, plaintextEmail } = useStore();
  const isMobile = useMobile();

  const isReply = !!(composeData?.isReply || composeData?.isReplyAll);
  const isForward = !!composeData?.isForward;

  const [toChips, setToChips] = useState(() => parseChips(composeData?.to));
  const [toInput, setToInput] = useState('');
  const [ccChips, setCcChips] = useState(() => parseChips(composeData?.cc));
  const [ccInput, setCcInput] = useState('');
  const [bccChips, setBccChips] = useState(() => parseChips(composeData?.bcc));
  const [bccInput, setBccInput] = useState('');
  const [subject, setSubject] = useState(() => composeData?.subject || '');
  const [body, setBody] = useState(() => composeData?.body || '');
  const [quotedBody, setQuotedBody] = useState(() => composeData?.quotedBody || '');
  const [quotedBodyHtml] = useState(() => composeData?.quotedBodyHtml || null);
  const [showDiscardSheet, setShowDiscardSheet] = useState(false);

  // Baseline values captured at open time — used to detect unsaved changes
  const initialBodyRef = useRef(composeData?.body || '');
  const initialSubjectRef = useRef(composeData?.subject || '');
  const initialToRef = useRef(normalizeTo(composeData?.to || []));
  const [showCc, setShowCc] = useState(() => !!(composeData?.cc?.length));
  const [showBcc, setShowBcc] = useState(() => !!(composeData?.bcc?.length));

  // Re-apply on mount — guards against Zustand state not being ready during first render
  useEffect(() => {
    if (composeData?.to?.length) setToChips(parseChips(composeData.to));
    if (composeData?.cc?.length) { setCcChips(parseChips(composeData.cc)); setShowCc(true); }
    if (composeData?.bcc?.length) { setBccChips(parseChips(composeData.bcc)); setShowBcc(true); }
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

  const getSuggestions = useCallback(async (q) => {
    try {
      const data = await api.suggestContacts(q);
      return data.contacts || [];
    } catch (_) { return []; }
  }, []);

  const [replyAll, setReplyAll] = useState(() => !!composeData?.isReplyAll);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [minimized, setMinimized] = useState(false);
  const [showReplyType, setShowReplyType] = useState(false);
  const replyTypeRef = useRef(null);
  const textareaRef = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false },
      }),
      TextStyle,
      TiptapColor,
      FontFamily,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: t('compose.bodyPh') }),
    ],
    content: composeData?.body || '',
    autofocus: (isReply || isForward) && !plaintextEmail ? 'start' : false,
    immediatelyRender: false,
  });

  // Track visible viewport height so the compose panel shrinks with the keyboard.
  // Also pin the panel's top edge to the visual viewport to prevent it shifting
  // up when iOS scrolls the layout viewport after a keyboard appears.
  const [viewportHeight, setViewportHeight] = useState(
    () => window.visualViewport?.height ?? window.innerHeight
  );
  const composePanelRef = useRef(null);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setViewportHeight(vv.height);
      // Apply top and height directly to the DOM — avoids a re-render on every
      // scroll/resize tick. Updating height here (not just top) ensures the panel
      // shrinks immediately when the keyboard opens rather than waiting a frame,
      // which would leave it extending behind the keyboard.
      if (composePanelRef.current) {
        composePanelRef.current.style.top = vv.offsetTop + 'px';
        composePanelRef.current.style.height = vv.height + 'px';
      }
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [isMobile]);

  // On mobile, prevent iOS from auto-zooming when inputs are focused.
  // All inputs already use 16px font-size but iOS can still scale on focus
  // inside position:fixed overlays. Restore the original content on unmount.
  useEffect(() => {
    if (!isMobile) return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    if (!original.includes('maximum-scale')) {
      meta.content = original + ', maximum-scale=1';
    }
    return () => { meta.content = original; };
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
    const bodyToSend = plaintextEmail ? body : (editor?.getHTML() ?? '');
    try {
      await api.post('/mail/send', {
        accountId,
        ...(aliasId ? { aliasId } : {}),
        to: toFinal,
        cc: [...ccChips, ...(ccInput.trim() ? [ccInput.trim()] : [])],
        bcc: [...bccChips, ...(bccInput.trim() ? [bccInput.trim()] : [])],
        subject,
        body: bodyToSend,
        bodyIsHtml: !plaintextEmail,
        ...(quotedBody ? { quotedBody } : {}),
        ...(!plaintextEmail && quotedBodyHtml ? { quotedBodyHtml } : {}),
        inReplyTo: composeData?.inReplyTo,
        references: composeData?.references || undefined,
      });
      closeCompose();
      const sentFolder = accounts.find(a => a.id === accountId)?.folder_mappings?.sent || 'Sent';
      addNotification({
        title: t('compose.sent.title'),
        body: subject || t('common.noSubject'),
        onAction: () => setSelectedAccount(accountId, sentFolder),
        actionLabel: t('compose.sent.action'),
      });
    } catch (err) {
      setError(err.message);
      setSending(false);
    }
  };

  const modeLabel = isReply
    ? (replyAll ? t('compose.replyAll') : t('compose.reply'))
    : isForward ? t('compose.forward') : t('compose.newMessage');

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
      setBccChips([]); setBccInput(''); setShowBcc(false);
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
      <>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1999,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        background: 'rgba(0,0,0,0.25)',
        animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
      }} />
      <div
        ref={composePanelRef}
        onKeyDown={handleKeyDown}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0,
          height: viewportHeight,
          paddingTop: 'var(--sat)',
          background: 'var(--bg-secondary)',
          zIndex: 2000,
          display: 'flex', flexDirection: 'column',
          animation: 'sheet-enter var(--motion-normal) var(--ease-emphasized) both',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '10px 14px', flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <button
            onClick={() => {
              const currentBody = plaintextEmail ? body : (editor?.isEmpty ? '' : (editor?.getHTML() ?? ''));
              const isDirty =
                currentBody !== initialBodyRef.current ||
                subject !== initialSubjectRef.current ||
                normalizeTo(toChips) !== initialToRef.current ||
                toInput.trim() !== '';
              if (isDirty) {
                setShowDiscardSheet(true);
              } else {
                closeCompose();
              }
            }}
            style={{
              background: 'none', border: 'none',
              color: 'var(--accent)', fontSize: 16,
              cursor: 'pointer', padding: '4px 0', minWidth: 60,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {t('common.cancel')}
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
            {sending ? sendSpinner : t('compose.send')}
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
              { label: t('compose.reply'), active: !replyAll, onTap: switchToReply },
              { label: t('compose.replyAll'), active: replyAll, onTap: switchToReplyAll },
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
            <span style={labelStyle}>{t('compose.from')}</span>
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
            <span style={{ ...labelStyle, paddingTop: 10 }}>{t('compose.to')}</span>
            <ChipInput
              chips={toChips} onChipsChange={setToChips}
              value={toInput} onChange={setToInput}
              placeholder={t('compose.toPh')}
              autoFocus={!isReply && !isForward}
              inputStyle={mobileInputStyle}
              getSuggestions={getSuggestions}
            />
            {(!showCc || !showBcc) && (
              <div style={{ display: 'flex', flexShrink: 0 }}>
                {!showCc && (
                  <button
                    onClick={() => setShowCc(true)}
                    style={{
                      background: 'none', border: 'none',
                      color: 'var(--text-tertiary)', cursor: 'pointer',
                      fontSize: 13, padding: '10px 0 4px 8px',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    {t('compose.cc')}
                  </button>
                )}
                {!showBcc && (
                  <button
                    onClick={() => setShowBcc(true)}
                    style={{
                      background: 'none', border: 'none',
                      color: 'var(--text-tertiary)', cursor: 'pointer',
                      fontSize: 13, padding: '10px 0 4px 8px',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    {t('compose.bcc')}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Cc */}
          {showCc && (
            <div style={{ ...fieldStyle, alignItems: 'flex-start', paddingTop: 4 }}>
              <span style={{ ...labelStyle, paddingTop: 10 }}>{t('compose.cc')}</span>
              <ChipInput
                chips={ccChips} onChipsChange={setCcChips}
                value={ccInput} onChange={setCcInput}
                placeholder={t('compose.ccPh')}
                inputStyle={mobileInputStyle}
                getSuggestions={getSuggestions}
              />
            </div>
          )}

          {/* Bcc */}
          {showBcc && (
            <div style={{ ...fieldStyle, alignItems: 'flex-start', paddingTop: 4 }}>
              <span style={{ ...labelStyle, paddingTop: 10 }}>{t('compose.bcc')}</span>
              <ChipInput
                chips={bccChips} onChipsChange={setBccChips}
                value={bccInput} onChange={setBccInput}
                placeholder={t('compose.bccPh')}
                inputStyle={mobileInputStyle}
                getSuggestions={getSuggestions}
              />
            </div>
          )}

          {/* Subject */}
          <div style={fieldStyle}>
            <span style={labelStyle}>{t('compose.subject')}</span>
            <input
              type="text" value={subject} onChange={e => setSubject(e.target.value)}
              placeholder={t('compose.subject')}
              style={mobileInputStyle}
            />
          </div>

          {/* Body */}
          {plaintextEmail ? (
            <textarea
              ref={textareaRef}
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder={t('compose.bodyPh')}
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
          ) : (
            <div className="tiptap-compose" style={{ flex: 1, minHeight: 200 }}>
              <RichToolbar editor={editor} />
              <EditorContent editor={editor} />
            </div>
          )}

          {/* Signature */}
          {fromSignature && (
            <div style={{ padding: '0 16px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '8px 0 6px', userSelect: 'none' }}>
                -- signature
              </div>
              <div
                style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(fromSignature) }}
              />
            </div>
          )}

          {/* Quoted body */}
          {(quotedBody || quotedBodyHtml) && (
            !plaintextEmail && quotedBodyHtml ? (
              <QuotedEmailFrame html={quotedBodyHtml} mobile />
            ) : (
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
            )
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

      {/* Discard confirmation sheet */}
      {showDiscardSheet && (
        <>
          <div
            onClick={() => setShowDiscardSheet(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 2100,
              background: 'rgba(0,0,0,0.4)',
            }}
          />
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0,
            zIndex: 2101, background: 'var(--bg-elevated)',
            borderRadius: '16px 16px 0 0',
            paddingBottom: 'calc(var(--sab) + 8px)',
            boxShadow: 'var(--shadow-modal)',
            animation: 'sheet-enter 0.22s var(--ease-emphasized) both',
          }}>
            <div style={{
              padding: '16px 20px 8px',
              fontSize: 15, fontWeight: 600, color: 'var(--text-primary)',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              Discard draft?
            </div>
            <button
              onClick={closeCompose}
              style={{
                width: '100%', padding: '16px 20px', textAlign: 'left',
                background: 'none', border: 'none',
                color: 'var(--red)', fontSize: 16, fontWeight: 500,
                cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              Discard
            </button>
            <button
              onClick={() => setShowDiscardSheet(false)}
              style={{
                width: '100%', padding: '16px 20px', textAlign: 'left',
                background: 'none', border: 'none',
                color: 'var(--accent)', fontSize: 16, fontWeight: 500,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              Keep editing
            </button>
          </div>
        </>
      )}
      </>
    );
  }

  // ── Desktop compose ─────────────────────────────────────────────────────────

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
          boxShadow: 'var(--shadow-soft)', zIndex: 1000,
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
        animation: 'compose-enter var(--motion-normal) var(--ease-emphasized) both',
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
              {replyAll ? t('compose.replyAll') : t('compose.reply')}
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
                  label={t('compose.reply')}
                  active={!replyAll}
                  onClick={() => {
                    setToChips(parseChips(composeData?.originalFrom || composeData?.to));
                    setToInput(''); setCcChips([]); setCcInput(''); setShowCc(false);
                    setBccChips([]); setBccInput(''); setShowBcc(false);
                    setReplyAll(false);
                    setShowReplyType(false);
                  }}
                />
                <DropItem
                  icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>}
                  label={t('compose.replyAll')}
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

      {/* Fields — fixed height, not scrollable so toolbar dropdowns aren't clipped */}
      <div style={{ flexShrink: 0 }}>
        {/* From */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>{t('compose.from')}</span>
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
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0, paddingTop: 9 }}>{t('compose.to')}</span>
          <ChipInput
            chips={toChips} onChipsChange={setToChips}
            value={toInput} onChange={setToInput}
            placeholder={t('compose.toPh')}
            autoFocus={!isReply && !isForward}
            inputStyle={{ ...inputStyle, borderBottom: 'none', padding: '6px 4px' }}
            getSuggestions={getSuggestions}
          />
          {(!showCc || !showBcc) && (
            <div style={{ display: 'flex', flexShrink: 0 }}>
              {!showCc && (
                <button onClick={() => setShowCc(true)} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '9px 0 4px 6px' }}>
                  {t('compose.cc')}
                </button>
              )}
              {!showBcc && (
                <button onClick={() => setShowBcc(true)} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '9px 0 4px 6px' }}>
                  {t('compose.bcc')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Cc */}
        {showCc && (
          <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0, paddingTop: 9 }}>{t('compose.cc')}</span>
            <ChipInput
              chips={ccChips} onChipsChange={setCcChips}
              value={ccInput} onChange={setCcInput}
              placeholder={t('compose.ccPh')}
              inputStyle={{ ...inputStyle, borderBottom: 'none', padding: '6px 4px' }}
              getSuggestions={getSuggestions}
            />
          </div>
        )}

        {/* Bcc */}
        {showBcc && (
          <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0, paddingTop: 9 }}>{t('compose.bcc')}</span>
            <ChipInput
              chips={bccChips} onChipsChange={setBccChips}
              value={bccInput} onChange={setBccInput}
              placeholder={t('compose.bccPh')}
              inputStyle={{ ...inputStyle, borderBottom: 'none', padding: '6px 4px' }}
              getSuggestions={getSuggestions}
            />
          </div>
        )}

        {/* Subject */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 52, flexShrink: 0 }}>{t('compose.subject')}</span>
          <input
            type="text" value={subject} onChange={e => setSubject(e.target.value)}
            placeholder={t('compose.subject')}
            style={{ flex: 1, ...inputStyle, borderBottom: 'none', padding: '8px 4px' }}
          />
        </div>
      </div>

      {/* Toolbar — sits outside overflow container so dropdowns are never clipped */}
      {!plaintextEmail && <RichToolbar editor={editor} />}

      {/* Scrollable body area */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {/* Body */}
        {plaintextEmail ? (
          <textarea
            ref={textareaRef}
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder={t('compose.bodyPh')}
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
        ) : (
          <div className="tiptap-compose" style={{ minHeight: isReply || isForward ? 120 : 200 }}>
            <EditorContent editor={editor} />
          </div>
        )}

        {fromSignature ? (
          <div style={{ padding: '0 14px 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, userSelect: 'none' }}>
              -- signature
            </div>
            <div
              style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(fromSignature) }}
            />
          </div>
        ) : null}

        {(quotedBody || quotedBodyHtml) ? (
          !plaintextEmail && quotedBodyHtml ? (
              <QuotedEmailFrame html={quotedBodyHtml} />
          ) : (
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
          )
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
          title={sending ? undefined : t('compose.sendTooltip')}
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
          {sending ? t('compose.sending') : t('compose.send')}
        </button>

        {error && <span style={{ fontSize: 12, color: 'var(--red)', flex: 1 }}>{error}</span>}

        <button onClick={closeCompose} style={{
          marginLeft: 'auto', background: 'none', border: 'none',
          color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12, padding: '4px 8px',
        }}>
          {t('compose.discard')}
        </button>
      </div>
    </div>
  );
}

const COLORS = ['#000000','#444444','#888888','#ffffff','#e03131','#f76707','#f59f00','#2f9e44','#1971c2','#7048e8','#c2255c'];
const FONTS = [
  { label: 'Default', value: '' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", Helvetica, sans-serif' },
];

// Defined at module level so React never remounts it due to reference change
const TBtn = forwardRef(function TBtn({ active, title, onMouseDown, children }, ref) {
  return (
    <button
      ref={ref}
      title={title}
      onMouseDown={onMouseDown}
      style={{
        background: active ? 'var(--bg-hover)' : 'none',
        border: 'none', borderRadius: 4, padding: '3px 6px',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 12, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center',
      }}
    >
      {children}
    </button>
  );
});

function Sep() {
  return <span style={{ width: 1, background: 'var(--border-subtle)', margin: '2px 4px', alignSelf: 'stretch' }} />;
}

function RichToolbar({ editor }) {
  const [colorPos, setColorPos] = useState(null);
  const [emojiPos, setEmojiPos] = useState(null);
  const [linkPos, setLinkPos] = useState(null);
  const [linkUrl, setLinkUrl] = useState('');
  const colorBtnRef = useRef(null);
  const emojiBtnRef = useRef(null);
  const linkBtnRef = useRef(null);
  const colorPopRef = useRef(null);
  const emojiPopRef = useRef(null);
  const linkPopRef = useRef(null);

  useEffect(() => {
    if (!colorPos && !emojiPos && !linkPos) return;
    const handler = (e) => {
      if (colorPos && colorBtnRef.current && !colorBtnRef.current.contains(e.target) && colorPopRef.current && !colorPopRef.current.contains(e.target)) setColorPos(null);
      if (emojiPos && emojiBtnRef.current && !emojiBtnRef.current.contains(e.target) && emojiPopRef.current && !emojiPopRef.current.contains(e.target)) setEmojiPos(null);
      if (linkPos && linkBtnRef.current && !linkBtnRef.current.contains(e.target) && linkPopRef.current && !linkPopRef.current.contains(e.target)) setLinkPos(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [colorPos, emojiPos, linkPos]);

  const es = useEditorState({
    editor,
    selector: ({ editor: ed }) => ed ? {
      bold: ed.isActive('bold'),
      italic: ed.isActive('italic'),
      underline: ed.isActive('underline'),
      strike: ed.isActive('strike'),
      bulletList: ed.isActive('bulletList'),
      orderedList: ed.isActive('orderedList'),
      link: ed.isActive('link'),
      alignLeft: ed.isActive({ textAlign: 'left' }),
      alignCenter: ed.isActive({ textAlign: 'center' }),
      alignRight: ed.isActive({ textAlign: 'right' }),
      color: ed.getAttributes('textStyle').color,
      fontFamily: ed.getAttributes('textStyle').fontFamily,
    } : {},
  });

  if (!editor) return null;

  const openColor = (e) => {
    e.preventDefault();
    if (colorPos) { setColorPos(null); return; }
    const r = colorBtnRef.current.getBoundingClientRect();
    setColorPos({ top: r.bottom + 4, left: r.left });
    setEmojiPos(null); setLinkPos(null);
  };
  const openEmoji = (e) => {
    e.preventDefault();
    if (emojiPos) { setEmojiPos(null); return; }
    const r = emojiBtnRef.current.getBoundingClientRect();
    // open upward so it doesn't go off-screen at the bottom
    setEmojiPos({ bottom: window.innerHeight - r.top + 4, left: Math.min(r.left, window.innerWidth - 360) });
    setColorPos(null); setLinkPos(null);
  };
  const openLink = (e) => {
    e.preventDefault();
    if (linkPos) { setLinkPos(null); return; }
    const r = linkBtnRef.current.getBoundingClientRect();
    const left = Math.max(4, Math.min(r.left, window.innerWidth - 300));
    setLinkPos({ top: r.bottom + 4, left });
    setColorPos(null); setEmojiPos(null);
    setLinkUrl(editor.getAttributes('link').href || '');
  };
  const submitLink = () => {
    if (linkUrl) {
      const href = linkUrl.startsWith('http') ? linkUrl : 'https://' + linkUrl;
      editor.chain().focus().setLink({ href }).run();
      // unsetMark() skips collapsed selections and never touches storedMarks,
      // so we go through the ProseMirror transaction API directly to remove
      // the link mark from storedMarks — otherwise the next typed char is linked.
      const linkMark = editor.schema.marks.link;
      if (linkMark) {
        const tr = editor.state.tr;
        tr.removeStoredMark(linkMark);
        editor.view.dispatch(tr);
      }
    } else {
      editor.chain().focus().unsetLink().run();
    }
    setLinkPos(null);
    setLinkUrl('');
  };

  const tb = (active, title, onMD, children) => (
    <TBtn key={title} active={active} title={title} onMouseDown={onMD}>{children}</TBtn>
  );

  return (
    <>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 2, padding: '4px 10px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Font picker */}
        <select
          value={es.fontFamily || ''}
          onChange={e => {
            if (e.target.value) editor.chain().focus().setFontFamily(e.target.value).run();
            else editor.chain().focus().unsetFontFamily().run();
          }}
          style={{
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            borderRadius: 4, color: 'var(--text-secondary)', fontSize: 11,
            padding: '2px 4px', cursor: 'pointer', outline: 'none', maxWidth: 100,
          }}
        >
          {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>

        <Sep />

        {tb(es.bold, 'Bold', e => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }, <b>B</b>)}
        {tb(es.italic, 'Italic', e => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }, <i>I</i>)}
        {tb(es.underline, 'Underline', e => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }, <u>U</u>)}
        {tb(es.strike, 'Strikethrough', e => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }, <s>S</s>)}

        <Sep />

        <button ref={colorBtnRef} title="Text color" onMouseDown={openColor}
          style={{ background: 'none', border: 'none', borderRadius: 4, padding: '3px 6px', cursor: 'pointer', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', lineHeight: 1 }}>A</span>
          <span style={{ width: 12, height: 3, borderRadius: 1, background: es.color || 'var(--text-primary)' }} />
        </button>

        <Sep />

        {tb(es.alignLeft, 'Align left', e => { e.preventDefault(); editor.chain().focus().setTextAlign('left').run(); },
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>)}
        {tb(es.alignCenter, 'Align center', e => { e.preventDefault(); editor.chain().focus().setTextAlign('center').run(); },
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>)}
        {tb(es.alignRight, 'Align right', e => { e.preventDefault(); editor.chain().focus().setTextAlign('right').run(); },
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg>)}

        <Sep />

        {tb(es.bulletList, 'Bullet list', e => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); },
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>)}
        {tb(es.orderedList, 'Numbered list', e => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); },
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="1" y="8" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">1.</text><text x="1" y="14" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">2.</text><text x="1" y="20" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">3.</text></svg>)}

        <Sep />

        <TBtn ref={linkBtnRef} active={es.link} title="Insert link" onMouseDown={openLink}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
        </TBtn>
        <button ref={emojiBtnRef} title="Emoji" onMouseDown={openEmoji}
          style={{ background: 'none', border: 'none', borderRadius: 4, padding: '3px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
          <span style={{ fontSize: 13, lineHeight: 1 }}>😀</span>
        </button>
      </div>

      {/* Popups — position:fixed so they escape any overflow clipping */}
      {colorPos && (
        <div ref={colorPopRef} style={{
          position: 'fixed', top: colorPos.top, left: colorPos.left, zIndex: 9900,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 8, boxShadow: 'var(--shadow-popover)',
          display: 'flex', flexWrap: 'wrap', gap: 4, width: 136,
        }}>
          {COLORS.map(c => (
            <button key={c} onMouseDown={e => { e.preventDefault(); editor.chain().focus().setColor(c).run(); setColorPos(null); }}
              style={{ width: 18, height: 18, borderRadius: 4, background: c, border: '1px solid var(--border)', cursor: 'pointer', padding: 0,
                outline: editor.isActive('textStyle', { color: c }) ? '2px solid var(--accent)' : 'none', outlineOffset: 1 }} />
          ))}
          <button onMouseDown={e => { e.preventDefault(); editor.chain().focus().unsetColor().run(); setColorPos(null); }}
            title="Remove color"
            style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer', padding: 0, fontSize: 9, color: 'var(--text-tertiary)', background: 'none' }}>✕</button>
        </div>
      )}

      {linkPos && (
        <div ref={linkPopRef} style={{
          position: 'fixed', top: linkPos.top, left: linkPos.left, zIndex: 9900,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '10px 12px', boxShadow: 'var(--shadow-popover)',
          display: 'flex', flexDirection: 'column', gap: 8, width: 280,
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 500 }}>Insert link</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input autoFocus value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitLink(); } if (e.key === 'Escape') setLinkPos(null); }}
              placeholder="https://..."
              style={{ flex: 1, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 12, outline: 'none' }} />
            <button onMouseDown={e => { e.preventDefault(); submitLink(); }}
              style={{ background: 'var(--accent)', border: 'none', borderRadius: 5, color: 'white', fontSize: 12, padding: '6px 12px', cursor: 'pointer', flexShrink: 0 }}>Apply</button>
          </div>
          {es.link && (
            <button onMouseDown={e => { e.preventDefault(); editor.chain().focus().unsetLink().run(); setLinkPos(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 11, cursor: 'pointer', padding: 0, textAlign: 'left' }}>
              Remove link
            </button>
          )}
        </div>
      )}

      {emojiPos && (
        <div ref={emojiPopRef} style={{ position: 'fixed', bottom: emojiPos.bottom, left: emojiPos.left, zIndex: 9900 }}>
          <Picker data={emojiData} onEmojiSelect={emoji => { editor.chain().focus().insertContent(emoji.native).run(); setEmojiPos(null); }}
            theme="auto" previewPosition="none" skinTonePosition="none"
            perLine={8} emojiSize={20} emojiButtonSize={28} maxFrequentRows={2} />
        </div>
      )}
    </>
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

function QuotedEmailFrame({ html, mobile }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(200);

  const srcDoc = `<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
    <base target="_blank">
  </head><body>${html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')}<style>
    html, body { height: auto !important; min-height: 0 !important; overflow-x: hidden !important; margin: 0 !important; padding: 0 !important; }
    body { font-family: -apple-system, Arial, sans-serif; font-size: 13px; line-height: 1.6; color: #ccc; background: transparent !important; word-wrap: break-word; overflow-wrap: break-word; }
    * { max-width: 100% !important; box-sizing: border-box !important; }
    img { max-width: 100% !important; height: auto !important; }
    table { table-layout: auto !important; }
    a { color: #7c6af7; }
    pre, code { white-space: pre-wrap; word-break: break-all; }
  </style></body></html>`;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const h = Math.max(
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
      );
      if (h > 0) setHeight(Math.min(h, 400));
    };
    iframe.addEventListener('load', onLoad, { once: true });
    if (iframe.contentDocument?.readyState === 'complete') onLoad();
    return () => iframe.removeEventListener('load', onLoad);
  }, [html]);

  return (
    <div style={{
      borderTop: '1px solid var(--border-subtle)',
      padding: mobile ? '0 16px' : '0 14px',
    }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        scrolling="no"
        sandbox="allow-same-origin allow-popups"
        title="Quoted email"
        style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height }}
      />
    </div>
  );
}

function ChipInput({ chips, onChipsChange, value, onChange, placeholder, autoFocus, inputStyle, getSuggestions }) {
  const [suggestions, setSuggestions] = useState([]);
  const [suggIdx, setSuggIdx] = useState(-1);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);
  const [dropStyle, setDropStyle] = useState(null);

  // Debounce contact suggestions — only when getSuggestions is wired up
  useEffect(() => {
    if (!getSuggestions) return;
    clearTimeout(debounceRef.current);
    const q = value.trim();
    if (q.length < 2) { setSuggestions([]); setSuggIdx(-1); setDropStyle(null); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await getSuggestions(q);
        if (!results.length) { setSuggestions([]); setDropStyle(null); return; }
        // Measure wrapper position for the fixed dropdown — escapes overflow:auto containers
        if (wrapperRef.current) {
          const rect = wrapperRef.current.getBoundingClientRect();
          setDropStyle({ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 220) });
        }
        setSuggestions(results);
        setSuggIdx(-1);
      } catch (_) {}
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [value, getSuggestions]);

  const clearSuggestions = () => { setSuggestions([]); setSuggIdx(-1); setDropStyle(null); };

  const commitInput = () => {
    const trimmed = value.trim();
    if (trimmed) { onChipsChange([...chips, trimmed]); onChange(''); }
    clearSuggestions();
  };

  const commitSuggestion = (contact) => {
    const formatted = contact.name ? `${contact.name} <${contact.email}>` : contact.email;
    onChipsChange([...chips, formatted]);
    onChange('');
    clearSuggestions();
  };

  const handleKeyDown = (e) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggIdx(i => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggIdx(i => Math.max(i - 1, -1)); return; }
      if (e.key === 'Escape') { clearSuggestions(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && suggIdx >= 0) { e.preventDefault(); commitSuggestion(suggestions[suggIdx]); return; }
    }
    if (e.key === ',' || e.key === 'Enter' || e.key === 'Tab') {
      if (value.trim()) { e.preventDefault(); commitInput(); }
    } else if (e.key === 'Backspace' && !value && chips.length) {
      onChipsChange(chips.slice(0, -1));
    }
  };

  return (
    <div ref={wrapperRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1, alignItems: 'center', padding: '5px 0', minWidth: 0 }}>
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
      {suggestions.length > 0 && dropStyle && (
        <div style={{
          position: 'fixed',
          top: dropStyle.top, left: dropStyle.left, width: dropStyle.width,
          zIndex: 9800,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: 'var(--shadow-popover)',
          overflow: 'hidden',
        }}>
          {suggestions.map((contact, i) => (
            <div
              key={contact.email}
              onMouseDown={e => { e.preventDefault(); commitSuggestion(contact); }}
              onMouseEnter={() => setSuggIdx(i)}
              style={{
                padding: '8px 12px', cursor: 'pointer',
                background: i === suggIdx ? 'var(--bg-hover)' : 'transparent',
                borderBottom: i < suggestions.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                transition: 'background 0.08s',
              }}
            >
              {contact.name && (
                <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, lineHeight: 1.3 }}>
                  {contact.name}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
                {contact.email}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

