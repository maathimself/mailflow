import { useState, useRef } from 'react';
import { TextBlock } from './blocks/TextBlock.jsx';
import { ImageBlock } from './blocks/ImageBlock.jsx';
import { DividerBlock } from './blocks/DividerBlock.jsx';
import { ColumnsBlock } from './blocks/ColumnsBlock.jsx';
import { ButtonBlock } from './blocks/ButtonBlock.jsx';
import { SocialBlock } from './blocks/SocialBlock.jsx';
import { SpacerBlock } from './blocks/SpacerBlock.jsx';
import { ListBlock } from './blocks/ListBlock.jsx';
import { btnGhost } from './styles.js';

const BLOCK_TYPES = [
  { type: 'text',    label: 'Text' },
  { type: 'image',   label: 'Image' },
  { type: 'button',  label: 'Button' },
  { type: 'divider', label: 'Divider' },
  { type: 'spacer',  label: 'Spacer' },
  { type: 'columns', label: 'Columns' },
  { type: 'list',    label: 'List' },
  { type: 'social',  label: 'Social' },
];

function newBlock(type) {
  const defaults = {
    text:    { type: 'paragraph', content: '', align: 'left', color: '#000000', fontSize: '', bold: false, italic: false },
    image:   { src: '', alt: '', href: '' },
    button:  { label: 'Click here', href: '', backgroundColor: '#007bff', color: '#ffffff' },
    divider: { color: '#e0e0e0', width: '1px' },
    spacer:  { height: '24px' },
    columns: { columns: [{ content: '' }, { content: '' }] },
    list:    { listType: 'ul', items: '' },
    social:  { items: [] },
  };
  return { id: crypto.randomUUID(), type, props: defaults[type] ?? {} };
}

function getBlockLabel(block) {
  const p = block.props ?? {};
  switch (block.type) {
    case 'text': {
      const labels = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', paragraph: 'Text' };
      return labels[p.type] ?? 'Text';
    }
    case 'button':  return p.label ? `Button — ${p.label}` : 'Button';
    case 'image':   return 'Image';
    case 'divider': return 'Divider';
    case 'spacer':  return `Spacer (${p.height ?? '24px'})`;
    case 'columns': return `Columns (${(p.columns ?? []).length})`;
    case 'list':    return p.listType === 'ol' ? 'Numbered list' : 'Bullet list';
    case 'social':  return `Social links (${(p.items ?? []).length})`;
    default:        return block.type;
  }
}

function BlockEditor({ block, onUpdate }) {
  const map = {
    text:    TextBlock,
    image:   ImageBlock,
    divider: DividerBlock,
    columns: ColumnsBlock,
    button:  ButtonBlock,
    social:  SocialBlock,
    spacer:  SpacerBlock,
    list:    ListBlock,
  };
  const Component = map[block.type];
  return Component ? <Component block={block} onChange={onUpdate} /> : null;
}

export function TemplateEditor({ blocks, onChange }) {
  const [expandedId, setExpandedId] = useState(null);
  const dragIdx = useRef(null);

  const addBlock = (type) => {
    const next = [...blocks, newBlock(type)];
    onChange(next);
    setExpandedId(next[next.length - 1].id);
  };

  const removeBlock = (blockId) => {
    const next = blocks.filter(b => b.id !== blockId);
    onChange(next);
    setExpandedId(id => (id === blockId ? null : id));
  };

  const moveUp = (blockId) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx <= 0) return;
    const next = [...blocks];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
    setExpandedId(next[idx - 1].id);
  };

  const moveDown = (blockId) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1 || idx === blocks.length - 1) return;
    const next = [...blocks];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
    setExpandedId(next[idx + 1].id);
  };

  const updateBlock = (blockId, updatedProps) => {
    onChange(
      blocks.map(b => (b.id === blockId ? { ...b, props: updatedProps } : b))
    );
  };

  const onDragStart = (e, blockId) => { dragIdx.current = blockId; e.dataTransfer.effectAllowed = 'move'; };
  const onDragOver  = (e, blockId) => {
    e.preventDefault();
    if (dragIdx.current == null || dragIdx.current === blockId) return;
    const from = blocks.findIndex(b => b.id === dragIdx.current);
    const to   = blocks.findIndex(b => b.id === blockId);
    if (from === -1 || to === -1) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    dragIdx.current = blockId;
    onChange(next);
  };
  const onDragEnd = () => { dragIdx.current = null; };

  return (
    <div>
      {blocks.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No blocks yet. Add one below.
        </div>
      )}

      {blocks.map((block, idx) => (
        <div
          key={block.id}
          draggable
          onDragStart={e => onDragStart(e, block.id)}
          onDragOver={e => onDragOver(e, block.id)}
          onDragEnd={onDragEnd}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            marginBottom: 8,
            background: 'var(--bg-secondary)',
            cursor: 'grab',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '6px 10px', gap: 6,
            borderBottom: expandedId === block.id ? '1px solid var(--border)' : 'none',
          }}>
            <span
              style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setExpandedId(expandedId === block.id ? null : block.id)}
            >
              {getBlockLabel(block)}
            </span>
            <button
              type="button"
              onClick={() => moveUp(block.id)}
              disabled={idx === 0}
              title="Move up"
              style={{ fontSize: 12, background: 'none', border: 'none', cursor: idx === 0 ? 'default' : 'pointer', padding: '0 4px', color: 'var(--text-secondary)', opacity: idx === 0 ? 0.3 : 1 }}
            >↑</button>
            <button
              type="button"
              onClick={() => moveDown(block.id)}
              disabled={idx === blocks.length - 1}
              title="Move down"
              style={{ fontSize: 12, background: 'none', border: 'none', cursor: idx === blocks.length - 1 ? 'default' : 'pointer', padding: '0 4px', color: 'var(--text-secondary)', opacity: idx === blocks.length - 1 ? 0.3 : 1 }}
            >↓</button>
            <button
              type="button"
              onClick={() => removeBlock(block.id)}
              title="Remove"
              style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', padding: '0 4px' }}
            >×</button>
          </div>
          {expandedId === block.id && (
            <div style={{ padding: 12 }}>
              <BlockEditor block={block} onUpdate={updated => updateBlock(block.id, updated.props)} />
            </div>
          )}
        </div>
      ))}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Add block
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {BLOCK_TYPES.map(bt => (
            <button
              key={bt.type}
              type="button"
              onClick={() => addBlock(bt.type)}
              style={{ ...btnGhost, fontSize: 12, padding: '4px 10px' }}
            >
              {bt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
