// Run with: node --test src/utils/senderCategory.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { senderScopeValue, matchesSenderScope } from './senderCategory.js';

describe('sender category helpers (#490)', () => {
  it('derives the address or @domain the rule matches, lowercased', () => {
    const msg = { from_email: ' Orders@Shop.Example ' };
    assert.equal(senderScopeValue(msg, 'sender'), 'orders@shop.example');
    assert.equal(senderScopeValue(msg, 'domain'), '@shop.example');
  });

  it('has nothing to match without a usable address', () => {
    for (const from_email of ['', null, 'no-at-sign', '@shop.example', 'name@']) {
      assert.equal(senderScopeValue({ from_email }, 'sender'), null, String(from_email));
    }
  });

  it('covers the inbox messages the rule and the server update cover', () => {
    const inbox = from_email => ({ folder: 'INBOX', from_email });
    assert.equal(matchesSenderScope(inbox('ORDERS@shop.example'), 'sender', 'orders@shop.example'), true);
    assert.equal(matchesSenderScope(inbox('news@shop.example'), 'sender', 'orders@shop.example'), false);
    assert.equal(matchesSenderScope(inbox('news@shop.example'), 'domain', '@shop.example'), true);
    assert.equal(matchesSenderScope(inbox('news@notshop.example'), 'domain', '@shop.example'), false);
    assert.equal(matchesSenderScope({ folder: 'Archive', from_email: 'orders@shop.example' }, 'sender', 'orders@shop.example'), false);
  });
});
