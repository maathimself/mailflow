import { inputStyle, selectStyle, labelStyle } from '../styles.js';

const TYPE_OPTIONS = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'h1',        label: 'Heading 1' },
  { value: 'h2',        label: 'Heading 2' },
  { value: 'h3',        label: 'Heading 3' },
];

const FONT_SIZE_OPTIONS = [
  { value: '',     label: 'Default' },
  { value: '12px', label: '12px' },
  { value: '13px', label: '13px' },
  { value: '14px', label: '14px' },
  { value: '16px', label: '16px' },
  { value: '18px', label: '18px' },
  { value: '20px', label: '20px' },
  { value: '24px', label: '24px' },
];

export function TextBlock({ block, onChange }) {
  const p = block.props ?? {};
  const set = (key, val) => onChange({ ...block, props: { ...p, [key]: val } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <label style={{ ...labelStyle, flex: 1 }}>
          Type
          <select
            value={p.type ?? 'paragraph'}
            onChange={e => set('type', e.target.value)}
            style={{ ...selectStyle, marginTop: 4, width: '100%' }}
          >
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ ...labelStyle, flex: 1 }}>
          Font size
          <select
            value={p.fontSize ?? ''}
            onChange={e => set('fontSize', e.target.value)}
            style={{ ...selectStyle, marginTop: 4, width: '100%' }}
          >
            {FONT_SIZE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      <label style={labelStyle}>
        Content
        <textarea
          rows={4}
          style={{ ...inputStyle, marginTop: 4, resize: 'vertical' }}
          value={p.content ?? ''}
          placeholder="Enter text…"
          onChange={e => set('content', e.target.value)}
        />
      </label>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={labelStyle}>
          Align
          <select
            value={p.align ?? 'left'}
            onChange={e => set('align', e.target.value)}
            style={{ ...selectStyle, marginLeft: 6 }}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label style={labelStyle}>
          Color
          <input
            type="color"
            value={p.color ?? '#000000'}
            onChange={e => set('color', e.target.value)}
            style={{ marginLeft: 6, width: 32, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' }}
          />
        </label>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={p.bold ?? false}
            onChange={e => set('bold', e.target.checked)}
            style={{ margin: 0 }}
          />
          Bold
        </label>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={p.italic ?? false}
            onChange={e => set('italic', e.target.checked)}
            style={{ margin: 0 }}
          />
          Italic
        </label>
      </div>
    </div>
  );
}
