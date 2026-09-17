import { useState, useEffect, useRef } from 'react';
import { templateApi } from './templateApi.js';
import { blocksToEditorHtml } from './blocksToEditorHtml.js';

export function TemplateInsertButton({ insertHtml }) {
  const [open, setOpen]           = useState(false);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [flipUp, setFlipUp]       = useState(false);
  const panelRef  = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    templateApi.list()
      .then(data => setTemplates(data.templates ?? []))
      .catch(() => setError('Could not load templates'))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setFlipUp(rect.bottom + 260 > window.innerHeight);
    }
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler); };
  }, [open]);

  const handleInsert = (tpl) => {
    const html = blocksToEditorHtml(tpl.blocks ?? []);
    if (html) insertHtml(html);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        type="button"
        title="Insert template"
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
        style={{
          padding: '0 6px',
          background: open ? 'var(--bg-secondary)' : 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 13,
          color: 'var(--text-secondary)',
          borderRadius: 4,
          lineHeight: '28px',
          transition: 'background 0.1s',
        }}
      >
        Template
      </button>
      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute',
            [flipUp ? 'bottom' : 'top']: '110%',
            left: 0,
            zIndex: 200,
            minWidth: 220,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-popover)',
            padding: 8,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 6, paddingLeft: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Insert template
          </div>
          {loading && <div style={{ fontSize: 12, padding: '6px 4px', color: 'var(--text-tertiary)' }}>Loading…</div>}
          {error && <div style={{ fontSize: 12, padding: '4px', color: 'var(--red)' }}>{error}</div>}
          {!loading && templates.length === 0 && !error && (
            <div style={{ fontSize: 12, padding: '6px 4px', color: 'var(--text-tertiary)' }}>
              No templates. Create one from the Templates icon in the sidebar.
            </div>
          )}
          {templates.map(tpl => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => handleInsert(tpl)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', borderRadius: 6,
                padding: '6px 8px', cursor: 'pointer', fontSize: 13,
                color: 'var(--text-primary)', transition: 'background 0.1s',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              {tpl.name}
              {tpl.description && (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  {tpl.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
