import { inputStyle, btnGhost } from '../styles.js';

export function ColumnsBlock({ block, onChange }) {
  const p = block.props ?? {};
  const cols = Array.isArray(p.columns) ? p.columns : [{ content: '' }, { content: '' }];

  const updateCol = (idx, content) => {
    const next = cols.map((c, i) => i === idx ? { ...c, content } : c);
    onChange({ ...block, props: { ...p, columns: next } });
  };

  const addCol = () => onChange({ ...block, props: { ...p, columns: [...cols, { content: '' }] } });
  const removeCol = (idx) => {
    if (cols.length <= 2) return;
    onChange({ ...block, props: { ...p, columns: cols.filter((_, i) => i !== idx) } });
  };

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {cols.map((col, idx) => (
          <div key={idx} style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Col {idx + 1}</span>
              {cols.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeCol(idx)}
                  style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: '0 2px' }}
                >×</button>
              )}
            </div>
            <textarea
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontSize: 12 }}
              value={col.content ?? ''}
              onChange={e => updateCol(idx, e.target.value)}
            />
          </div>
        ))}
      </div>
      {cols.length < 4 && (
        <button
          type="button"
          onClick={addCol}
          style={{ ...btnGhost, marginTop: 8 }}
        >+ Add column</button>
      )}
    </div>
  );
}
