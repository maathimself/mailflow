import { useTemplateManager } from './useTemplateManager.js';
import { TemplateEditor } from './TemplateEditor.jsx';
import { inputStyle, btnPrimary, btnSecondary, btnGhost } from './styles.js';

export function TemplateManagerSettings() {
  const {
    templates, loading,
    showNew, inForm,
    form, setForm,
    saving, error,
    startCreate, startEdit, cancelEdit,
    handleDelete, handleSave,
  } = useTemplateManager();

  if (inForm) {
    return (
      <div>
        <div style={{ marginBottom: 12 }}>
          <button type="button" onClick={cancelEdit} style={btnGhost}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 4 }}>
              <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
            Back to list
          </button>
        </div>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--text-primary)' }}>
          {showNew ? 'New template' : 'Edit template'}
        </h3>
        {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Name *
            <input
              type="text"
              style={{ ...inputStyle, display: 'block', marginTop: 4 }}
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Description
            <input
              type="text"
              style={{ ...inputStyle, display: 'block', marginTop: 4 }}
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </label>
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 8 }}>Blocks</div>
          <TemplateEditor blocks={form.blocks} onChange={blocks => setForm(f => ({ ...f, blocks }))} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{ ...btnPrimary, opacity: saving ? 0.6 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Saving…' : 'Save template'}
          </button>
          <button type="button" onClick={cancelEdit} style={btnSecondary}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text-primary)' }}>Email Templates</h3>
        <button type="button" onClick={startCreate} style={btnPrimary}>+ New template</button>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
          No templates yet. Create your first one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.map(tpl => (
            <div
              key={tpl.id}
              style={{
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '10px 12px', display: 'flex', alignItems: 'center',
                gap: 8, background: 'var(--bg-secondary)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {tpl.name}
                </div>
                {tpl.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{tpl.description}</div>
                )}
              </div>
              <button type="button" onClick={() => startEdit(tpl)} style={btnGhost}>Edit</button>
              <button type="button" onClick={() => handleDelete(tpl)} style={{ ...btnGhost, color: 'var(--red)', borderColor: 'var(--red)' }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
