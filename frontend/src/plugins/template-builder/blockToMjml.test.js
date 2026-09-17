import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMjml } from './blockToMjml.js';

describe('blocksToMjml', () => {
  it('returns a valid mjml wrapper for an empty block list', () => {
    const out = blocksToMjml([]);
    assert.ok(out.includes('<mjml>'));
    assert.ok(out.includes('<mj-body>'));
  });

  it('renders a text block', () => {
    const out = blocksToMjml([{ type: 'text', props: { content: 'Hello', color: '#333', align: 'center' } }]);
    assert.ok(out.includes('<mj-text'));
    assert.ok(out.includes('Hello'));
    assert.ok(out.includes('color="#333"'));
    assert.ok(out.includes('align="center"'));
  });

  it('escapes HTML entities in text content', () => {
    const out = blocksToMjml([{ type: 'text', props: { content: '<b>bold & "quoted"</b>' } }]);
    assert.ok(out.includes('&lt;b&gt;'));
    assert.ok(out.includes('&amp;'));
  });

  it('renders an image block', () => {
    const out = blocksToMjml([{ type: 'image', props: { src: 'https://example.com/img.png', alt: 'Logo', width: '200px' } }]);
    assert.ok(out.includes('<mj-image'));
    assert.ok(out.includes('src="https://example.com/img.png"'));
    assert.ok(out.includes('alt="Logo"'));
  });

  it('blocks javascript: URIs in image src', () => {
    const out = blocksToMjml([{ type: 'image', props: { src: 'javascript:alert(1)', alt: '' } }]);
    assert.ok(!out.includes('javascript:'));
    assert.ok(out.includes('src="#"'));
  });

  it('blocks javascript: URIs in image href', () => {
    const out = blocksToMjml([{ type: 'image', props: { src: 'https://img.png', href: 'javascript:alert(1)' } }]);
    assert.ok(!out.includes('javascript:'));
    assert.ok(out.includes('href="#"'));
  });

  it('renders a divider block', () => {
    const out = blocksToMjml([{ type: 'divider', props: { color: '#ccc', width: '2px' } }]);
    assert.ok(out.includes('<mj-divider'));
    assert.ok(out.includes('border-color="#ccc"'));
    assert.ok(out.includes('border-width="2px"'));
  });

  it('renders a columns block', () => {
    const out = blocksToMjml([{ type: 'columns', props: { columns: [{ content: 'Left' }, { content: 'Right' }] } }]);
    assert.ok(out.includes('<mj-section>'));
    assert.ok(out.includes('Left'));
    assert.ok(out.includes('Right'));
  });

  it('ignores unknown block types', () => {
    const out = blocksToMjml([{ type: 'unknown', props: {} }]);
    assert.ok(!out.includes('unknown'));
  });

  it('handles null/undefined props gracefully', () => {
    assert.doesNotThrow(() => blocksToMjml([{ type: 'text' }]));
    assert.doesNotThrow(() => blocksToMjml([{ type: 'image' }]));
    assert.doesNotThrow(() => blocksToMjml([{ type: 'divider' }]));
    assert.doesNotThrow(() => blocksToMjml([{ type: 'columns' }]));
  });
});
