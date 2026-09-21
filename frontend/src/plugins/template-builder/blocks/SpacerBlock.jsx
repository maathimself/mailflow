import { selectStyle, labelStyle } from '../styles.js';

const HEIGHT_OPTIONS = [
  { value: '8px',  label: '8px — XS' },
  { value: '16px', label: '16px — S' },
  { value: '24px', label: '24px — M' },
  { value: '32px', label: '32px — L' },
  { value: '48px', label: '48px — XL' },
  { value: '64px', label: '64px — 2XL' },
];

export function SpacerBlock({ block, onChange }) {
  const p = block.props ?? {};
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
      <label style={labelStyle}>
        Height
        <select
          value={p.height ?? '24px'}
          onChange={e => onChange({ ...block, props: { ...p, height: e.target.value } })}
          style={{ ...selectStyle, marginLeft: 8 }}
        >
          {HEIGHT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <div style={{
        flex: 1, height: parseInt(p.height ?? '24px', 10) / 2,
        minHeight: 4, maxHeight: 32,
        background: 'var(--bg-tertiary)',
        border: '1px dashed var(--border)',
        borderRadius: 2,
      }} />
    </div>
  );
}
