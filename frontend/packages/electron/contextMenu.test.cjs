const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const menuSource = source.slice(source.indexOf('function showContextMenu('), source.indexOf('\nfunction getDefaultWindowBounds('));

function openMenu(params) {
  let template;
  let popup;
  const replacements = [];
  const owner = {};
  const contents = { replaceMisspelling: word => replacements.push(word) };
  const context = vm.createContext({
    Menu: { buildFromTemplate(items) { template = items; return { popup(options) { popup = options; } }; } },
    BrowserWindow: { fromWebContents(target) { assert.equal(target, contents); return owner; } },
    mainWindow: {},
  });
  vm.runInContext(`${menuSource}\nthis.showContextMenu = showContextMenu;`, context);
  context.showContextMenu(contents, params);
  return { template, popup, owner, replacements };
}

test('spelling suggestions precede editing actions and replace the clicked misspelling', () => {
  const { template, popup, owner, replacements } = openMenu({
    isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help'],
  });
  assert.deepEqual(Array.from(template.slice(0, 2), item => item.label), ['hello', 'help']);
  assert.equal(template[2].type, 'separator');
  assert.equal(template[3].role, 'cut');
  assert.equal(popup.window, owner);
  assert.deepEqual(replacements, []);
  template[1].click();
  assert.deepEqual(replacements, ['help']);
  template[0].click();
  assert.deepEqual(replacements, ['help', 'hello']);
});

test('empty or unavailable suggestions leave the native editing actions intact', () => {
  for (const dictionarySuggestions of [[], undefined]) {
    const { template } = openMenu({ isEditable: true, misspelledWord: 'helo', dictionarySuggestions });
    assert.deepEqual(Array.from(template, item => item.role || item.type), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
  }
});

test('correctly spelled text does not add spelling actions', () => {
  const { template } = openMenu({ isEditable: true, misspelledWord: '', dictionarySuggestions: ['hello'] });
  assert.equal(template[0].role, 'cut');
});

test('noneditable selections keep their existing menu without spelling actions', () => {
  const { template } = openMenu({ isEditable: false, selectionText: 'helo', misspelledWord: 'helo', dictionarySuggestions: ['hello'] });
  assert.deepEqual(Array.from(template, item => item.role), ['copy', 'selectAll']);
});
