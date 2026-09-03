import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from 'prosemirror-state';
import StarterKit from '@tiptap/starter-kit';
import { ComposerLink } from './editorLink.js';

// The composer's real extension set, minus everything irrelevant to the link mark.
// getSchema and prosemirror-state both run headless, so this exercises the actual
// ProseMirror behaviour with no browser and no jsdom.
const schema = getSchema([StarterKit.configure({ link: false }), ComposerLink]);

// Put the caret at the trailing edge of a linked URL and type. Returns the marks that
// the newly typed text ended up carrying, which is exactly what #415 got wrong.
function typeAfterLink(text) {
  const link = schema.marks.link.create({ href: 'https://example.com' });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('https://example.com', [link])]),
  ]);
  let state = EditorState.create({ doc });
  state = state.apply(state.tr.setSelection(
    TextSelection.near(state.doc.resolve(doc.content.size - 1)),
  ));
  const after = state.apply(state.tr.insertText(text));

  let tail = null;
  after.doc.descendants(node => { if (node.isText) tail = node; });
  return {
    text: tail.text,
    linked: tail.marks.some(m => m.type.name === 'link'),
  };
}

describe('ComposerLink', () => {
  test('the link mark is not inclusive', () => {
    assert.equal(schema.marks.link.spec.inclusive, false);
  });

  test('typing after a pasted link does not extend the link (#415)', () => {
    const result = typeAfterLink(' and more text');
    assert.equal(result.linked, false, 'typed text must not become part of the link');
    // A separate text node, so the anchor still covers only the URL.
    assert.equal(result.text, ' and more text');
  });

  test('no character is absorbed, not just space', () => {
    // The issue was reported as a space problem. The cause is mark inclusivity, which is
    // character agnostic, so pin every kind of character the report might have implied.
    for (const ch of [' ', 'x', '!', ' ']) {
      assert.equal(typeAfterLink(ch).linked, false, `"${ch}" must not join the link`);
    }
  });

  test('autolink stays enabled, so typed URLs still linkify', () => {
    // Guards the lazy fix: setting autolink:false would also make the mark non-inclusive
    // and would pass the assertions above while silently killing typed-URL linking.
    assert.equal(ComposerLink.options.autolink, true);
  });

  test('openOnClick stays disabled, as the composer requires', () => {
    // extend() then configure() must not drop the option StarterKit used to pass.
    assert.equal(ComposerLink.options.openOnClick, false);
  });

  test('the mark still renders as an anchor carrying the href', () => {
    const link = schema.marks.link.create({ href: 'https://example.com' });
    assert.equal(link.attrs.href, 'https://example.com');
    assert.equal(schema.marks.link.name, 'link');
  });
});

describe('upstream canary', () => {
  test('stock StarterKit link is still inclusive, so the override is still needed', () => {
    // Deliberate canary. This asserts UPSTREAM behaviour, so a TipTap upgrade that fixes
    // #415 at the source will fail this test. That failure is the signal, not a defect:
    // it means ComposerLink's inclusive() override can be deleted and this suite reduced
    // to the behavioural tests above. Do not "fix" it by loosening the assertion.
    const stock = getSchema([StarterKit.configure({ link: { openOnClick: false } })]);
    assert.equal(
      stock.marks.link.spec.inclusive, true,
      'TipTap appears to have made the link mark non-inclusive upstream. If so, remove the '
      + 'inclusive() override in editorLink.js and delete this canary.',
    );
  });
});
