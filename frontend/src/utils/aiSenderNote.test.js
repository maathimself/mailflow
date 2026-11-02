import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// signatureText parses the signature HTML with the browser's DOMParser.
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const { signatureText, aiSenderNote } = await import('./aiSenderNote.js');

describe('signatureText', () => {
  test('keeps the line breaks a signature is laid out with', () => {
    assert.equal(
      signatureText('<div>Jordan Doe<br>Assistant General Manager</div><p>Example Arena</p><div>555-0100</div>'),
      'Jordan Doe\nAssistant General Manager\nExample Arena\n555-0100',
    );
  });

  test('whitespace between tags in hand-written HTML adds no blank lines or double spaces', () => {
    assert.equal(
      signatureText('<div>Jordan Doe</div>\n  <div>Assistant GM</div>\n<table>\n  <tr>\n    <td><b>Jordan</b>&nbsp;Doe &amp; Co</td> <td>555-0100</td>\n  </tr>\n</table>'),
      'Jordan Doe\nAssistant GM\nJordan Doe & Co 555-0100',
    );
  });

  test('table cells on one row stay apart', () => {
    assert.equal(signatureText('<table><tr><td>Jordan Doe</td><td>555-0100</td></tr></table>'), 'Jordan Doe 555-0100');
  });

  test('keeps a blank line the signature has, but no more than one', () => {
    assert.equal(signatureText('Jordan<br><br><br><br>Example Arena'), 'Jordan\n\nExample Arena');
  });

  test('an image stands in as [image], so a logo-only signature is still a signature', () => {
    assert.equal(signatureText('<p><img src="data:image/png;base64,AAAA" alt="logo"></p>'), '[image]');
    assert.equal(signatureText('<div>Jordan Doe <img src="x.png"></div>'), 'Jordan Doe [image]');
  });

  test('ignores style and script contents', () => {
    assert.equal(signatureText('<style>p { color: red }</style><p>Jordan</p><script>x()</script>'), 'Jordan');
  });

  test('caps a very long signature', () => {
    assert.equal(signatureText(`<p>${'a'.repeat(5000)}</p>`).length, 1000);
  });

  test('no signature is an empty string', () => {
    for (const value of ['', '   ', null, undefined, '<p></p>']) assert.equal(signatureText(value), '');
  });
});

const SIG = 'Jordan Doe\nExample Arena';
const NO_ADDED_CLOSING = /do not add a closing line, sign-off, name or contact details that it does not have/;

describe('aiSenderNote', () => {
  test('rewriting (Improve, Shorten, Fix grammar): keeps the closing the email has and adds none', () => {
    const note = aiSenderNote({ name: 'Jordan Doe', signature: SIG, rewriting: true });
    assert.match(note, /^The email is from Jordan Doe\.$/m);
    assert.ok(note.includes('"""\nJordan Doe\nExample Arena\n"""'));
    assert.match(note, /Keep the closing line, and any name after it, if the email has them/);
    assert.match(note, NO_ADDED_CLOSING);
    // Never told to strip a name the user typed, which Fix grammar must leave alone.
    assert.doesNotMatch(note, /Do not end the text with/);
  });

  test('rewriting without a signature or name still adds no closing', () => {
    assert.match(aiSenderNote({ rewriting: true }), NO_ADDED_CLOSING);
    assert.doesNotMatch(aiSenderNote({ name: 'Jordan Doe', rewriting: true }), /sign the email off/);
  });

  test('Draft with a signature: no name or contact details, and no second closing line', () => {
    const note = aiSenderNote({ name: 'Jordan Doe', signature: `Thank you,\n${SIG}` });
    assert.ok(note.includes('"""\nThank you,\nJordan Doe\nExample Arena\n"""'));
    assert.match(note, /Do not end the text with a signature, the sender's name or contact details/);
    assert.match(note, /already begins with a closing line/);
    assert.doesNotMatch(note, NO_ADDED_CLOSING);
  });

  test('Draft without a signature: signs off with the sender name instead of a placeholder', () => {
    const note = aiSenderNote({ name: '  Jordan Doe  ', signature: '   ' });
    assert.match(note, /No signature is added, so sign the email off as Jordan Doe\./);
    assert.doesNotMatch(note, /"""/);
  });

  test('with nothing known: only rules out placeholders', () => {
    assert.equal(
      aiSenderNote({}),
      'Never use placeholders such as [Your Name] or [Recipient Name]; leave out anything you do not know.',
    );
    assert.equal(aiSenderNote(), aiSenderNote({ name: null, signature: undefined }));
  });
});
