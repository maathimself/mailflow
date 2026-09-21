import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToEditorHtml } from './blocksToEditorHtml.js';

describe('blocksToEditorHtml', () => {
  it('returns empty for an empty block list', () => {
    assert.equal(blocksToEditorHtml([]), '');
    assert.equal(blocksToEditorHtml(null), '');
    assert.equal(blocksToEditorHtml(undefined), '');
  });

  it('renders a text block', () => {
    const out = blocksToEditorHtml([{ type: 'text', props: { content: 'Hello', color: '#ff0000', align: 'center' } }]);
    assert.ok(out.includes('<p'));
    assert.ok(out.includes('text-align:center'));
    assert.ok(out.includes('color:#ff0000;'));
    assert.ok(out.includes('Hello'));
  });

  it('omits color span when text is default black', () => {
    const out = blocksToEditorHtml([{ type: 'text', props: { content: 'Hello', color: '#000000' } }]);
    assert.ok(!out.includes('<span'));
    assert.ok(!out.includes('color:'));
  });

  it('blocks CSS injection via invalid color', () => {
    const out = blocksToEditorHtml([{ type: 'text', props: { content: 'X', color: 'red;background:url(javascript:alert(1))' } }]);
    assert.ok(!out.includes(';background'));  // inválido é filtrado por isValidColor
  });

  it('blocks CSS injection via invalid align', () => {
    const out = blocksToEditorHtml([{ type: 'text', props: { content: 'X', align: 'center;background:url(x)' } }]);
    assert.ok(!out.includes('center;background'));
    assert.ok(out.includes('text-align:left'));
  });

  it('blocks CSS injection via invalid divider width', () => {
    const out = blocksToEditorHtml([{ type: 'divider', props: { width: '1px;background:url(x)', color: '#e0e0e0' } }]);
    assert.ok(!out.includes('1px;background'));
    assert.ok(out.includes('border-top:1px solid'));
  });

  it('blocks javascript: URIs in image src and href', () => {
    const out = blocksToEditorHtml([{ type: 'image', props: { src: 'javascript:alert(1)', alt: '', href: 'javascript:void(0)' } }]);
    assert.ok(!out.includes('javascript:'));
  });

  it('renders a divider block', () => {
    const out = blocksToEditorHtml([{ type: 'divider', props: { color: '#ccc', width: '2px' } }]);
    assert.ok(out.includes('<hr'));
    assert.ok(out.includes('border-top:2px solid #ccc'));
  });

  it('renders a columns block', () => {
    const out = blocksToEditorHtml([{ type: 'columns', props: { columns: [{ content: 'Left' }, { content: 'Right' }] } }]);
    assert.ok(out.includes('<table'));
    assert.ok(out.includes('Left'));
    assert.ok(out.includes('Right'));
  });

  it('ignores unknown block types', () => {
    const out = blocksToEditorHtml([{ type: 'unknown', props: {} }]);
    assert.equal(out, '');
  });

  it('handles null/undefined props gracefully', () => {
    assert.doesNotThrow(() => blocksToEditorHtml([{ type: 'text' }]));
    assert.doesNotThrow(() => blocksToEditorHtml([{ type: 'image' }]));
    assert.doesNotThrow(() => blocksToEditorHtml([{ type: 'divider' }]));
    assert.doesNotThrow(() => blocksToEditorHtml([{ type: 'columns' }]));
  });
});