import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';

const BTN = {
  background: 'none', border: 'none', borderRadius: 4,
  color: 'var(--text-secondary)', cursor: 'pointer',
  padding: '3px 7px', fontSize: 13, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

function ToolBtn({ onClick, title, active, children }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      title={title}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...BTN,
        background: active || hov ? 'var(--bg-hover)' : 'none',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 3px', flexShrink: 0 }} />;
}

export default function SignatureEditor({ value, onChange }) {
  const { t } = useTranslation();
  const { addNotification } = useStore();
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const [showSource, setShowSource] = useState(false);
  const [sourceVal, setSourceVal] = useState('');

  // Seed the contenteditable on first mount only
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = value || '';
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = () => onChange(editorRef.current?.innerHTML || '');

  // onMouseDown + e.preventDefault() keeps focus in the contenteditable so
  // execCommand acts on the current selection rather than on nothing.
  const exec = (cmd, val) => {
    document.execCommand(cmd, false, val ?? null);
    editorRef.current?.focus();
    emit();
  };

  const insertLink = () => {
    const saved = saveSelection();
    const url = window.prompt(t('signatureEditor.linkPrompt'));
    restoreSelection(saved);
    if (url) exec('createLink', url.match(/^https?:\/\//) ? url : 'https://' + url);
  };

  const insertImageFromUrl = () => {
    const url = window.prompt(t('signatureEditor.imageUrlPrompt'));
    if (url) exec('insertImage', url);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 300 * 1024) {
      addNotification({ type: 'error', title: t('signatureEditor.imageTooLarge.title'), body: t('signatureEditor.imageTooLarge.body') });
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => exec('insertImage', reader.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const toggleSource = () => {
    if (!showSource) {
      // Visual → Source: capture current HTML
      const html = editorRef.current?.innerHTML || '';
      setSourceVal(html);
      setShowSource(true);
    } else {
      // Source → Visual: push raw HTML back into editor
      setShowSource(false);
      // Use a microtask so the div is back in the DOM before we write to it
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.innerHTML = sourceVal;
          onChange(sourceVal);
        }
      }, 0);
    }
  };

  const handleSourceChange = (e) => {
    setSourceVal(e.target.value);
    onChange(e.target.value);
  };

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8,
      overflow: 'hidden', background: 'var(--bg-tertiary)',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)',
        flexWrap: 'wrap', gap: 2,
      }}>
        <ToolBtn title={t('signatureEditor.bold')} onClick={() => exec('bold')}>
          <strong style={{ fontSize: 13 }}>B</strong>
        </ToolBtn>
        <ToolBtn title={t('signatureEditor.italic')} onClick={() => exec('italic')}>
          <em style={{ fontSize: 13 }}>I</em>
        </ToolBtn>
        <ToolBtn title={t('signatureEditor.underline')} onClick={() => exec('underline')}>
          <span style={{ textDecoration: 'underline', fontSize: 13 }}>U</span>
        </ToolBtn>
        <ToolBtn title={t('signatureEditor.strikethrough')} onClick={() => exec('strikeThrough')}>
          <span style={{ textDecoration: 'line-through', fontSize: 13 }}>S</span>
        </ToolBtn>

        <Sep />

        {/* Text color */}
        <label
          title={t('signatureEditor.textColor')}
          onMouseDown={e => e.preventDefault()}
          style={{ ...BTN, cursor: 'pointer', position: 'relative', padding: '3px 7px' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 3L5 21"/><path d="M15 3L19 21"/><path d="M5.5 12h13"/>
          </svg>
          <input
            type="color"
            defaultValue="#000000"
            onChange={e => exec('foreColor', e.target.value)}
            style={{ opacity: 0, position: 'absolute', width: 0, height: 0 }}
          />
        </label>

        <Sep />

        <ToolBtn title={t('signatureEditor.link')} onClick={insertLink}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
          </svg>
        </ToolBtn>

        <ToolBtn title={t('signatureEditor.imageUrl')} onClick={insertImageFromUrl}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
        </ToolBtn>

        <ToolBtn title={t('signatureEditor.imageUpload')} onClick={() => fileInputRef.current?.click()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </ToolBtn>
        <input ref={fileInputRef} type="file" accept="image/*"
          style={{ display: 'none' }} onChange={handleFileUpload} />

        <Sep />

        <ToolBtn title={showSource ? t('signatureEditor.visualMode') : t('signatureEditor.sourceMode')} active={showSource} onClick={toggleSource}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
        </ToolBtn>
      </div>

      {/* Editor area */}
      {showSource ? (
        <textarea
          value={sourceVal}
          onChange={handleSourceChange}
          spellCheck={false}
          style={{
            display: 'block', width: '100%', minHeight: 120,
            padding: '10px 12px', background: 'transparent',
            border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontFamily: 'monospace',
            fontSize: 12, lineHeight: 1.6, resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          style={{
            minHeight: 100, padding: '10px 12px',
            color: 'var(--text-primary)', fontSize: 13,
            lineHeight: 1.6, outline: 'none',
          }}
        />
      )}
    </div>
  );
}

// Save/restore selection so link prompt doesn't lose cursor position
function saveSelection() {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  return sel.getRangeAt(0).cloneRange();
}

function restoreSelection(range) {
  if (!range) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
