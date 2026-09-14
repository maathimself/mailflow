import { inputStyle, labelStyle } from '../styles.js';

export function ButtonBlock({ block, onChange }) {
  const p = block.props ?? {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
      <label style={labelStyle}>
        Label
        <input
          type="text"
          style={{ ...inputStyle, marginTop: 4 }}
          value={p.label ?? ''}
          placeholder="Click here"
          onChange={e => onChange({ ...block, props: { ...p, label: e.target.value } })}
        />
      </label>
      <label style={labelStyle}>
        URL
        <input
          type="url"
          style={{ ...inputStyle, marginTop: 4 }}
          value={p.href ?? ''}
          placeholder="https://…"
          onChange={e => onChange({ ...block, props: { ...p, href: e.target.value } })}
        />
      </label>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <label style={labelStyle}>
          Background
          <input
            type="color"
            value={p.backgroundColor ?? '#007bff'}
            onChange={e => onChange({ ...block, props: { ...p, backgroundColor: e.target.value } })}
            style={{ marginLeft: 6, width: 32, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' }}
          />
        </label>
        <label style={labelStyle}>
          Text color
          <input
            type="color"
            value={p.color ?? '#ffffff'}
            onChange={e => onChange({ ...block, props: { ...p, color: e.target.value } })}
            style={{ marginLeft: 6, width: 32, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' }}
          />
        </label>
      </div>
    </div>
  );
}
