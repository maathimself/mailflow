import { inputStyle, labelStyle } from '../styles.js';

export function DividerBlock({ block, onChange }) {
  const p = block.props ?? {};
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', padding: '4px 0' }}>
      <label style={labelStyle}>
        Color
        <input
          type="color"
          value={p.color ?? '#e0e0e0'}
          onChange={e => onChange({ ...block, props: { ...p, color: e.target.value } })}
          style={{ marginLeft: 6, width: 32, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' }}
        />
      </label>
      <label style={labelStyle}>
        Width
        <input
          type="text"
          style={{ ...inputStyle, marginTop: 4, width: 80 }}
          value={p.width ?? '1px'}
          onChange={e => onChange({ ...block, props: { ...p, width: e.target.value } })}
        />
      </label>
    </div>
  );
}
