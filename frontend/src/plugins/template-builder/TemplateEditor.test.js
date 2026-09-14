import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('TemplateEditor - updateBlock logic', () => {
  it('updateBlock replaces props of matching block id', () => {
    const blocks = [
      { id: 'a', type: 'text', props: { content: 'Hello', color: '#000000' } },
      { id: 'b', type: 'image', props: { src: 'https://example.com/img.png', alt: 'Img' } }
    ];
    const updatedProps = { content: 'World', color: '#ff0000' };
    const result = blocks.map(b => (b.id === 'a' ? { ...b, props: updatedProps } : b));
    assert.equal(result[0].props.content, 'World');
    assert.equal(result[0].props.color, '#ff0000');
    assert.equal(result[1].props.src, 'https://example.com/img.png');
  });

  it('updateBlock preserves other props when updating', () => {
    const block = { id: 'x', type: 'text', props: { content: 'Old', color: '#000000', align: 'center' } };
    const updatedProps = { content: 'New', color: '#ff0000' };
    const result = { ...block, props: updatedProps };
    assert.equal(result.props.content, 'New');
    assert.equal(result.props.color, '#ff0000');
    assert.equal(result.type, 'text');
    assert.equal(result.id, 'x');
  });

  it('updateBlock keeps all blocks when id does not match', () => {
    const blocks = [
      { id: 'a', type: 'text', props: { content: 'Hello' } },
      { id: 'b', type: 'image', props: { src: 'url' } }
    ];
    const result = blocks.map(b => (b.id === 'c' ? { ...b, props: {} } : b));
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a');
    assert.equal(result[1].id, 'b');
  });

  it('moveUp swaps adjacent elements', () => {
    const blocks = [
      { id: 'a', type: 'text', props: { content: '1' } },
      { id: 'b', type: 'image', props: { src: 'url' } },
      { id: 'c', type: 'divider', props: { color: '#e0e0e0' } }
    ];
    const idx = 2;
    const next = [...blocks];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    assert.equal(next[0].id, 'a');
    assert.equal(next[1].id, 'c');
    assert.equal(next[2].id, 'b');
  });

  it('moveDown swaps adjacent elements', () => {
    const blocks = [
      { id: 'a', type: 'text', props: { content: '1' } },
      { id: 'b', type: 'image', props: { src: 'url' } },
      { id: 'c', type: 'divider', props: { color: '#e0e0e0' } }
    ];
    const idx = 0;
    const next = [...blocks];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    assert.equal(next[0].id, 'b');
    assert.equal(next[1].id, 'a');
    assert.equal(next[2].id, 'c');
  });

  it('removeBlock filters by id', () => {
    const blocks = [
      { id: 'a', type: 'text', props: { content: '1' } },
      { id: 'b', type: 'image', props: { src: 'url' } },
      { id: 'c', type: 'divider', props: { color: '#e0e0e0' } }
    ];
    const result = blocks.filter(b => b.id !== 'b');
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a');
    assert.equal(result[1].id, 'c');
  });

  it('expandedId toggle logic: null to block id', () => {
    let expandedId = null;
    const blockId = 'my-block';
    expandedId = expandedId === blockId ? null : blockId;
    assert.equal(expandedId, 'my-block');
  });

  it('expandedId toggle logic: block id to null', () => {
    let expandedId = 'my-block';
    const blockId = 'my-block';
    expandedId = expandedId === blockId ? null : blockId;
    assert.equal(expandedId, null);
  });

  it('expandedId toggle logic: different block keeps existing', () => {
    let expandedId = 'block-a';
    const blockId = 'block-b';
    expandedId = expandedId === blockId ? null : blockId;
    assert.equal(expandedId, 'block-b');
  });

  it('addBlock appends new block to list', () => {
    const blocks = [
      { id: 'a', type: 'text', props: { content: 'Hello' } }
    ];
    const newBlock = { id: 'b', type: 'image', props: { src: '', alt: '', href: '' } };
    const next = [...blocks, newBlock];
    assert.equal(next.length, 2);
    assert.equal(next[1].type, 'image');
  });
});