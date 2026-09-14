import { inputStyle, selectStyle, labelStyle } from '../styles.js';

export function ListBlock({ block, onChange }) {
  const p = block.props ?? {};
  const set = (key, val) => onChange({ ...block, props: { ...p, [key]: val } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
      <label style={labelStyle}>
        List type
        <select
          value={p.listType ?? 'ul'}
          onChange={e => set('listType', e.target.value)}
          style={{ ...selectStyle, marginLeft: 8 }}
        >
          <option value="ul">Bullet list</option>
          <option value="ol">Numbered list</option>
        </select>
      </label>
      <label style={labelStyle}>
        Items <span style={{ fontWeight: 400 }}>(one per line)</span>
        <textarea
          rows={5}
          style={{ ...inputStyle, marginTop: 4, resize: 'vertical' }}
          value={p.items ?? ''}
          placeholder={'Item 1\nItem 2\nItem 3'}
          onChange={e => set('items', e.target.value)}
        />
      </label>
    </div>
  );
}
