// An on/off setting: its name and what it does, with a switch on the right.
export default function ToggleRow({ label, desc, checked, onChange, disabled = false }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      padding: '10px 12px', borderRadius: 8,
      background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={{
          width: 44, height: 24, borderRadius: 12,
          background: checked ? 'var(--accent)' : 'var(--bg-elevated)',
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
          cursor: disabled ? 'not-allowed' : 'pointer',
          position: 'relative', transition: 'all 0.2s', flexShrink: 0,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: checked ? 22 : 3,
          width: 16, height: 16, borderRadius: '50%', background: 'white',
          transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </button>
    </div>
  );
}

