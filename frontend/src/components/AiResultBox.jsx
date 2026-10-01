import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { renderMarkdown } from '../utils/renderMarkdown.js';
import { copyToClipboard } from '../utils/clipboard.js';

// A pinned AI result box shown above the message (#204). Collapsible to keep
// multiple results from crowding the view; offers regenerate and dismiss.
export default function AiResultBox({ result, canRegen, onRegen, onDismiss }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const loading = result.status === 'loading';
  const error = result.status === 'error';
  // Render the (markdown) AI output to sanitized HTML. Memoized on the text so toggling
  // expand/collapse doesn't re-parse; re-runs as text streams in during generation (#215).
  const html = useMemo(() => renderMarkdown(result.text || ''), [result.text]);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copyTimerRef.current), []);
  // Copy the output to the clipboard as BOTH rich text (the rendered HTML) and source
  // (the raw markdown), so pasting into a rich editor gives formatting and pasting into a
  // plain field gives the markdown source (#215). Falls back to plain text where the async
  // clipboard / ClipboardItem isn't available (e.g. non-secure context).
  const handleCopy = async () => {
    const source = result.text || '';
    const flash = () => {
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    };
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new window.ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([source], { type: 'text/plain' }),
        })]);
      } else {
        const { ok } = await copyToClipboard(source);
        if (!ok) return;
      }
      flash();
    } catch {
      // The rich path can fail on its own (no ClipboardItem, a rejected write). Fall back
      // to plain text through the shared helper, which also covers non-secure contexts
      // where navigator.clipboard does not exist at all.
      const { ok } = await copyToClipboard(source);
      if (ok) flash();
    }
  };
  const iconBtn = {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)',
    padding: '2px 4px', display: 'flex', alignItems: 'center', lineHeight: 1,
  };
  return (
    <div style={{
      padding: '12px 16px', background: 'var(--bg-secondary)',
      border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)',
      borderRadius: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase',
          letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {result.label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {loading && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic', marginRight: 4 }}>
              {t('compose.toolbar.aiGenerating')}
            </span>
          )}
          {canRegen && !loading && (
            <button onClick={onRegen} title={t('message.aiRegenerate')} aria-label={t('message.aiRegenerate')} style={iconBtn}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
          )}
          {!error && !loading && result.text && (
            <button onClick={handleCopy} title={copied ? t('message.aiCopied') : t('message.aiCopy')} aria-label={copied ? t('message.aiCopied') : t('message.aiCopy')} style={iconBtn}>
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              )}
            </button>
          )}
          {!error && !loading && (
            <button onClick={() => setExpanded(v => !v)} title={expanded ? t('message.aiCollapse') : t('message.aiExpand')} aria-label={expanded ? t('message.aiCollapse') : t('message.aiExpand')} style={iconBtn}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          )}
          <button onClick={onDismiss} aria-label={t('message.summaryDismiss')} style={{ ...iconBtn, fontSize: 14 }}>×</button>
        </div>
      </div>
      {loading && !result.text ? (
        <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{t('compose.toolbar.aiGenerating')}</span>
      ) : error ? (
        <span style={{ color: 'var(--red)' }}>{t('compose.toolbar.aiError', { message: result.text })}</span>
      ) : (
        <div
          className="ai-markdown"
          style={{ maxHeight: expanded ? 'none' : 220, overflowY: expanded ? 'visible' : 'auto' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
