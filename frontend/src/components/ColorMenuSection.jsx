import { useRef } from 'react';

export const HIGHLIGHT_COLORS = ['#ffd43b','#ffa94d','#ff8787','#f783ac','#da77f2','#748ffc','#4dabf7','#38d9a9','#69db7c','#a9e34b'];

function normalizeColor(color) {
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color || '');
  if (rgb) return '#' + rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('');
  return (color || '').toLowerCase();
}

export default function ColorMenuSection({ title, colors, activeColor, onColor, onClear, clearLabel, customColorLabel, noColorLabel, showNoColor, showClear = true }) {
  const customInputRef = useRef(null);
  const selectedColor = normalizeColor(activeColor);
  const customColor = /^#[0-9a-f]{6}$/i.test(selectedColor) ? selectedColor : '#000000';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 18px)', gap: 5 }}>
        {colors.map(c => (
          <button key={`${title}-${c}`} onMouseDown={e => e.preventDefault()} onClick={() => onColor(c)}
            title={c}
            style={{
              width: 18, height: 18, borderRadius: 2, background: c,
              border: c === '#ffffff' || c === '#f5f5f5' ? '1px solid var(--border)' : '1px solid transparent',
              cursor: 'pointer', padding: 0,
              outline: selectedColor === c ? '2px solid var(--accent)' : 'none', outlineOffset: 1,
            }}>
            {selectedColor === c && (
              <span style={{
                display: 'block', width: 10, height: 10, margin: 3,
                border: c === '#000000' || c === '#222222' || c === '#0c343d' || c === '#073763' || c === '#20124d' || c === '#4c1130'
                  ? '2px solid white'
                  : '2px solid #111',
                borderTop: 'none', borderLeft: 'none', transform: 'rotate(45deg)',
              }} />
            )}
          </button>
        ))}
      </div>
      <button onMouseDown={e => e.preventDefault()} onClick={() => customInputRef.current?.click()}
        style={{
          alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent)',
          fontSize: 12, padding: '2px 0', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
        <span style={{ width: 16, height: 16, background: customColor, border: '1px solid var(--border)', display: 'inline-block' }} />
        {customColorLabel}
      </button>
      <input ref={customInputRef} type="color" value={customColor}
        onChange={e => onColor(e.target.value)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }} />
      {showNoColor && (
        <button onMouseDown={e => e.preventDefault()} onClick={onClear}
          title={clearLabel}
          style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent)',
            fontSize: 12, padding: '0 0 2px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
          <span style={{
            width: 16, height: 16, border: '1px solid var(--border)', display: 'inline-block',
            background: 'linear-gradient(to bottom right, transparent calc(50% - 1px), #e03131 calc(50% - 1px), #e03131 calc(50% + 1px), transparent calc(50% + 1px))',
          }} />
          {noColorLabel}
        </button>
      )}
      {showClear && !showNoColor && (
        <button onMouseDown={e => e.preventDefault()} onClick={onClear}
          title={clearLabel}
          style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent)',
            fontSize: 12, padding: '0 0 2px', cursor: 'pointer',
          }}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}

