import { inputStyle, selectStyle, btnGhost } from '../styles.js';
import { SOCIAL_NETWORKS, SocialIcon } from '../socialIcons.js';

export function SocialBlock({ block, onChange }) {
  const p     = block.props ?? {};
  const items = Array.isArray(p.items) ? p.items : [];

  const updateItem = (idx, field, value) => {
    const next = items.map((it, i) => i === idx ? { ...it, [field]: value } : it);
    onChange({ ...block, props: { ...p, items: next } });
  };

  const addItem = () => onChange({
    ...block, props: { ...p, items: [...items, { name: 'domain', href: '', label: '' }] },
  });

  const removeItem = (idx) => onChange({
    ...block, props: { ...p, items: items.filter((_, i) => i !== idx) },
  });

  return (
    <div style={{ padding: '4px 0' }}>
      {items.map((item, idx) => (
        <div key={idx} style={{ marginBottom: 10, padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <SocialIcon name={item.name ?? 'domain'} size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
            <select
              value={item.name ?? 'domain'}
              onChange={e => updateItem(idx, 'name', e.target.value)}
              style={{ ...selectStyle, flex: 1, fontSize: 12 }}
            >
              {SOCIAL_NETWORKS.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => removeItem(idx)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 16, padding: '0 2px', flexShrink: 0, lineHeight: 1 }}
            >×</button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="url"
              placeholder="https://…"
              value={item.href ?? ''}
              onChange={e => updateItem(idx, 'href', e.target.value)}
              style={{ ...inputStyle, flex: 1, fontSize: 12 }}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={item.label ?? ''}
              onChange={e => updateItem(idx, 'label', e.target.value)}
              style={{ ...inputStyle, width: 120, fontSize: 12, flexShrink: 0 }}
            />
          </div>
        </div>
      ))}
      <button type="button" onClick={addItem} style={btnGhost}>+ Add social link</button>
    </div>
  );
}
