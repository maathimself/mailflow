const assert = require('node:assert/strict');
const test = require('node:test');
const { buildContextMenu } = require('./contextMenu.cjs');

function menu(params) {
  const actions = [];
  const items = buildContextMenu(params, {
    openLink: url => actions.push(['open', url]), copyText: text => actions.push(['copy', text]),
    print: () => actions.push(['print']),
  });
  return { items, actions, labels: items.map(item => item.label).filter(Boolean) };
}

test('selected text offers Print alongside Copy and Select All', () => {
  const { items, labels, actions } = menu({ selectionText: 'Selected email text' });
  assert.deepEqual(labels, ['Copy', 'Select All', 'Print']);
  items.find(item => item.label === 'Print').click();
  assert.deepEqual(actions, [['print']]);
});

test('image menus offer Print and preserve linked-image actions without duplicates', () => {
  const { items, labels, actions } = menu({ mediaType: 'image', srcURL: 'https://mail.test/image', linkURL: 'https://example.test', selectionText: 'Text' });
  assert.deepEqual(labels, ['Open Link', 'Copy Link', 'Copy Image Address', 'Copy', 'Select All', 'Print']);
  items.find(item => item.label === 'Copy Image Address').click();
  items.find(item => item.label === 'Print').click();
  assert.deepEqual(actions, [['copy', 'https://mail.test/image'], ['print']]);
  assert.deepEqual(menu({ mediaType: 'image', srcURL: 'data:image/png;base64,AA' }).labels, ['Copy Image Address', 'Print']);
});

test('editable controls, empty space, and bare links keep their existing menus', () => {
  assert.deepEqual(menu({ isEditable: true, selectionText: 'Draft' }).labels, ['Cut', 'Copy', 'Paste', 'Select All']);
  assert.deepEqual(menu({}).labels, []);
  assert.deepEqual(menu({ linkURL: 'https://example.test' }).labels, ['Open Link', 'Copy Link']);
});
