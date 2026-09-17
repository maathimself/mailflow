import { inputStyle, labelStyle } from '../styles.js';

export function ImageBlock({ block, onChange }) {
  const p = block.props ?? {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
      <label style={labelStyle}>
        Image URL
        <input
          type="url"
          style={{ ...inputStyle, marginTop: 4 }}
          value={p.src ?? ''}
          placeholder="https://…"
          onChange={e => onChange({ ...block, props: { ...p, src: e.target.value } })}
        />
      </label>
      <label style={labelStyle}>
        Alt text
        <input
          type="text"
          style={{ ...inputStyle, marginTop: 4 }}
          value={p.alt ?? ''}
          onChange={e => onChange({ ...block, props: { ...p, alt: e.target.value } })}
        />
      </label>
      <label style={labelStyle}>
        Link (optional)
        <input
          type="url"
          style={{ ...inputStyle, marginTop: 4 }}
          value={p.href ?? ''}
          placeholder="https://…"
          onChange={e => onChange({ ...block, props: { ...p, href: e.target.value } })}
        />
      </label>
    </div>
  );
}
