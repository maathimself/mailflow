import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildForwardBodyContent,
  buildReplyBodyContent,
  cacheCanonicalEmailBody,
  emailBodyTextForAi,
} from './emailBodyContent.js';

const canonicalHtml = '<p data-sentinel="canonical">Immutable body</p>';

describe('canonical email body consumers', () => {
  it('caches the canonical body object without reading rendered DOM', () => {
    const cache = {};
    const order = [];
    const body = { html: canonicalHtml, text: 'Immutable body' };

    cacheCanonicalEmailBody(cache, order, 'message-1', body, 2);

    assert.equal(cache['message-1'], body);
    assert.equal(cache['message-1'].html, canonicalHtml);
    assert.deepEqual(order, ['message-1']);
  });

  it('builds reply and forward HTML from the canonical body exactly once', () => {
    const body = { html: canonicalHtml, text: 'Immutable body' };
    const reply = buildReplyBodyContent({ body, date: 'Generic date', from: 'sender@example.invalid' });
    const forward = buildForwardBodyContent({
      body,
      date: 'Generic date',
      from: 'sender@example.invalid',
      subject: 'Generic subject',
      to: 'recipient@example.invalid',
      cc: '',
    });

    assert.equal(reply.html.split(canonicalHtml).length - 1, 1);
    assert.equal(forward.html.split(canonicalHtml).length - 1, 1);
    assert.equal(body.html, canonicalHtml);
  });

  it('derives AI text without mutating canonical HTML', () => {
    const body = { html: canonicalHtml };

    assert.equal(emailBodyTextForAi(body), 'Immutable body');
    assert.equal(body.html, canonicalHtml);
  });
});
