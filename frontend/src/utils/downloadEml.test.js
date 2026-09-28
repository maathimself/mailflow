import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadEml, emlDownloadUrl } from './downloadEml.js';

function fakeDocument() {
  const events = [];
  const body = {
    appendChild(el) { events.push(['append', el]); el.parent = body; },
  };
  return {
    events,
    body,
    createElement(tag) {
      const el = {
        tag,
        href: '',
        download: undefined,
        click() { events.push(['click', el.href, el.download]); },
        remove() { events.push(['remove', el]); },
      };
      return el;
    },
  };
}

describe('emlDownloadUrl', () => {
  it('points at the raw.eml route of the message', () => {
    assert.equal(emlDownloadUrl('0f1e2d3c-aaaa-bbbb-cccc-1234567890ab'),
      '/api/mail/messages/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab/raw.eml');
  });

  it('encodes the id so it cannot break out of the path', () => {
    assert.equal(emlDownloadUrl('a/../b?x'), '/api/mail/messages/a%2F..%2Fb%3Fx/raw.eml');
  });
});

describe('downloadEml', () => {
  it('clicks a same-origin download link and removes it again', () => {
    const doc = fakeDocument();
    assert.equal(downloadEml('msg-1', doc), true);
    const kinds = doc.events.map(e => e[0]);
    assert.deepEqual(kinds, ['append', 'click', 'remove']);
    const click = doc.events.find(e => e[0] === 'click');
    assert.equal(click[1], '/api/mail/messages/msg-1/raw.eml');
    assert.equal(click[2], '');
  });

  it('does nothing without a message id', () => {
    const doc = fakeDocument();
    assert.equal(downloadEml(undefined, doc), false);
    assert.equal(downloadEml('', doc), false);
    assert.deepEqual(doc.events, []);
  });

  it('does nothing without a document (non-browser context)', () => {
    assert.equal(downloadEml('msg-1', null), false);
  });
});
