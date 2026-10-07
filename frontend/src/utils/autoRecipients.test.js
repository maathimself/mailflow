import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bareAddress, autoListsOf, addAutoRecipients, presentAuto, noteRemoved,
  openAutoRecipients, replyTypeFields, swapAccountFields, splitAddressInput, autoRecipientFields,
} from './autoRecipients.js';

const lists = ({ cc = [], bcc = [] } = {}) => ({ cc, bcc });
const fields = ({ to = [], cc = [], bcc = [] } = {}) => ({ to, cc, bcc });
const without = (state, field, address) => ({ ...state, [field]: state[field].filter(c => bareAddress(c) !== address) });

describe('bareAddress', () => {
  it('reads plain, display-name and quoted-comma chips alike, ignoring case', () => {
    assert.equal(bareAddress('a@example.com'), 'a@example.com');
    assert.equal(bareAddress('Name <A@Example.org>'), 'a@example.org');
    assert.equal(bareAddress('"Last, First" <a@example.org>'), 'a@example.org');
    assert.equal(bareAddress('  B@Example.com '), 'b@example.com');
  });

  it('is empty for anything that is not a chip string', () => {
    assert.equal(bareAddress(undefined), '');
    assert.equal(bareAddress({ email: 'a@example.com' }), '');
  });
});

describe('autoListsOf', () => {
  it('gives empty lists for a missing account or fields that are not arrays', () => {
    assert.deepEqual(autoListsOf(undefined), { cc: [], bcc: [] });
    assert.deepEqual(autoListsOf({ auto_cc_addresses: null, auto_bcc_addresses: 'me@example.com' }), { cc: [], bcc: [] });
  });

  it('reads both lists and drops blank entries', () => {
    assert.deepEqual(
      autoListsOf({ auto_cc_addresses: ['boss@example.com', ' '], auto_bcc_addresses: [' me@example.com '] }),
      { cc: ['boss@example.com'], bcc: ['me@example.com'] },
    );
  });
});

describe('addAutoRecipients', () => {
  it('appends the lists after the recipients already there', () => {
    const out = addAutoRecipients(
      fields({ to: ['x@example.com'], cc: ['t@example.com'], bcc: ['u@example.com'] }),
      lists({ cc: ['boss@example.com'], bcc: ['me@example.com'] }),
    );
    assert.deepEqual(out.cc, ['t@example.com', 'boss@example.com']);
    assert.deepEqual(out.bcc, ['u@example.com', 'me@example.com']);
    assert.deepEqual([...out.placed.cc], ['boss@example.com']);
    assert.deepEqual([...out.placed.bcc], ['me@example.com']);
  });

  it('skips an address already in To, Cc or Bcc, ignoring case and display names', () => {
    const out = addAutoRecipients(
      fields({ to: ['Boss <BOSS@example.com>'], cc: ['"Me, Myself" <Me@Example.com>'], bcc: ['ARCHIVE@example.com'] }),
      lists({ cc: ['boss@example.com', 'archive@example.com'], bcc: ['me@example.com'] }),
    );
    assert.deepEqual(out.cc, ['"Me, Myself" <Me@Example.com>']);
    assert.deepEqual(out.bcc, ['ARCHIVE@example.com']);
    assert.equal(out.placed.cc.size + out.placed.bcc.size, 0);
  });

  it('skips suppressed addresses', () => {
    const out = addAutoRecipients(fields(), lists({ bcc: ['me@example.com', 'other@example.com'] }), new Set(['me@example.com']));
    assert.deepEqual(out.bcc, ['other@example.com']);
  });

  it('puts an address that is in both lists in Cc only', () => {
    const out = addAutoRecipients(fields(), lists({ cc: ['me@example.com'], bcc: ['ME@example.com'] }));
    assert.deepEqual(out.cc, ['me@example.com']);
    assert.deepEqual(out.bcc, []);
  });

  it('returns a field with nothing to add as the same array', () => {
    const start = fields({ cc: ['t@example.com'], bcc: [] });
    const out = addAutoRecipients(start, lists());
    assert.equal(out.cc, start.cc);
    assert.equal(out.bcc, start.bcc);
  });
});

describe('presentAuto', () => {
  it('collects the listed addresses found anywhere in To, Cc or Bcc, and nothing else', () => {
    const present = presentAuto(
      lists({ cc: ['boss@example.com'], bcc: ['me@example.com', 'absent@example.com'] }),
      fields({ to: ['Boss <boss@example.com>'], cc: ['x@example.com'], bcc: ['ME@example.com'] }),
    );
    assert.deepEqual([...present].sort(), ['boss@example.com', 'me@example.com']);
  });
});

describe('noteRemoved', () => {
  it('suppresses only addresses that were present and are now gone, keeping earlier ones', () => {
    const suppressed = noteRemoved(
      new Set(['me@example.com', 'boss@example.com']),
      new Set(['earlier@example.com']),
      fields({ to: ['x@example.com'], cc: ['Boss <boss@example.com>'], bcc: [] }),
    );
    assert.deepEqual([...suppressed].sort(), ['earlier@example.com', 'me@example.com']);
  });
});

// Opens and toggles a reply the way ComposeModal does: composeFromMessage puts the thread in Cc
// for Reply All only, and To is always the original sender.
const SENDER = 'Sender <sender@example.com>';
const openReply = ({ all, thread, lists: l }) =>
  openAutoRecipients(fields({ to: [SENDER], cc: all ? thread : [] }), l);
const toggle = (state, all, thread) =>
  replyTypeFields({ all, originalTo: [SENDER], allRecipients: thread, fields: state, auto: state.auto });
const inBoth = (state) => state.cc.map(bareAddress).filter(a => state.bcc.map(bareAddress).includes(a));

describe('replyTypeFields', () => {
  it('moves an automatic Bcc the thread already Cc\'d between Cc and Bcc as opening in each mode would', () => {
    const l = lists({ bcc: ['me@personal.example'] });
    const thread = ['Colleague <colleague@example.com>', 'me@personal.example'];
    const asReplyAll = openReply({ all: true, thread, lists: l });
    const asReply = openReply({ all: false, thread, lists: l });
    assert.deepEqual([asReplyAll.cc, asReplyAll.bcc], [thread, []], 'reply-all: Cc only');
    assert.deepEqual([asReply.cc, asReply.bcc], [[], ['me@personal.example']], 'reply: Bcc');

    const toReply = toggle(asReplyAll, false, thread);
    assert.deepEqual([toReply.cc, toReply.bcc], [asReply.cc, asReply.bcc]);
    const backToAll = toggle(toReply, true, thread);
    assert.deepEqual([backToAll.cc, backToAll.bcc], [asReplyAll.cc, asReplyAll.bcc]);
    assert.deepEqual(inBoth(backToAll), [], 'never in both Cc and Bcc');
  });

  it('keeps an automatic Cc that is on the thread through Reply, Reply All and Reply, from either start', () => {
    const l = lists({ cc: ['archive@example.com'] });
    const thread = ['x@example.com', 'archive@example.com'];
    for (const startAll of [false, true]) {
      let state = openReply({ all: startAll, thread, lists: l });
      for (const all of [!startAll, startAll, !startAll]) {
        state = toggle(state, all, thread);
        assert.ok(state.cc.map(bareAddress).includes('archive@example.com'), `start ${startAll ? 'reply-all' : 'reply'}, now ${all ? 'reply-all' : 'reply'}`);
        assert.equal(state.cc.filter(c => bareAddress(c) === 'archive@example.com').length, 1, 'listed once');
      }
    }
  });

  it('never leaves an address in both Cc and Bcc after Reply then Reply All', () => {
    const l = lists({ cc: ['boss@example.com'], bcc: ['me@example.com'] });
    const thread = ['me@example.com', 'boss@example.com', 'y@example.com'];
    const state = toggle(openReply({ all: false, thread, lists: l }), true, thread);
    assert.deepEqual(state.cc, thread);
    assert.deepEqual(state.bcc, []);
    assert.deepEqual(inBoth(state), []);
  });

  it('does not bring back an automatic chip the user removed before a toggle', () => {
    const l = lists({ bcc: ['me@example.com'] });
    const thread = ['x@example.com'];
    const removed = without(openReply({ all: false, thread, lists: l }), 'bcc', 'me@example.com');
    const toAll = toggle(removed, true, thread);
    assert.deepEqual(toAll.bcc, []);
    assert.deepEqual(toggle(toAll, false, thread).bcc, []);
  });

  it('keeps a Bcc the user typed on Reply to Reply All, recomputing only the automatic part', () => {
    const l = lists({ bcc: ['me@example.com'] });
    const thread = ['x@example.com'];
    const opened = openReply({ all: false, thread, lists: l });
    const typed = { ...opened, bcc: [...opened.bcc, 'u@example.com'] };
    const toAll = toggle(typed, true, thread);
    assert.deepEqual([...toAll.bcc].sort(), ['me@example.com', 'u@example.com']);
    assert.deepEqual(toAll.cc, thread);
  });

  it('still owns the automatic Cc after Reply All on a thread with no other recipients, so a From switch takes it out', () => {
    const toAll = toggle(openReply({ all: false, thread: [], lists: lists({ cc: ['boss@example.com'] }) }), true, []);
    assert.deepEqual(toAll.cc, ['boss@example.com']);
    assert.deepEqual(swapAccountFields({ fields: toAll, auto: toAll.auto, lists: lists() }).cc, []);
  });
});

describe('swapAccountFields', () => {
  const A = lists({ bcc: ['a@example.com'] });
  const B = lists({ bcc: ['b@example.com'] });

  it('replaces the old account\'s automatic addresses with the new account\'s', () => {
    const opened = openAutoRecipients(fields({ to: ['x@example.com'], bcc: ['u@example.com'] }), A);
    assert.deepEqual(opened.bcc, ['u@example.com', 'a@example.com']);
    const swapped = swapAccountFields({ fields: opened, auto: opened.auto, lists: B });
    assert.deepEqual(swapped.bcc, ['u@example.com', 'b@example.com']);
    assert.deepEqual(swapped.to, ['x@example.com']);
  });

  it('keeps an address the message supplied even when the old account lists it', () => {
    const opened = openAutoRecipients(fields({ to: ['x@example.com'], bcc: ['A@example.com'] }), A);
    assert.deepEqual(opened.bcc, ['A@example.com'], 'not added twice');
    const swapped = swapAccountFields({ fields: opened, auto: opened.auto, lists: lists() });
    assert.deepEqual(swapped.bcc, ['A@example.com']);
  });

  it('removes an automatic address a reply placed, although the thread had it in Cc', () => {
    const l = lists({ bcc: ['me@personal.example'] });
    const thread = ['me@personal.example'];
    const reply = openReply({ all: false, thread, lists: l });
    assert.deepEqual(reply.bcc, ['me@personal.example']);
    assert.deepEqual(swapAccountFields({ fields: reply, auto: reply.auto, lists: lists() }).bcc, []);
    const replyAll = openReply({ all: true, thread, lists: l });
    assert.deepEqual(swapAccountFields({ fields: replyAll, auto: replyAll.auto, lists: lists() }).cc, thread);
  });

  it('takes out only the chip it placed, keeping a named chip or a second copy the user added', () => {
    const opened = openAutoRecipients(
      fields({ to: ['x@example.com'] }),
      lists({ cc: ['boss@example.com'], bcc: ['archive@example.com'] }),
    );
    const added = {
      ...opened,
      cc: [...opened.cc, 'Boss Person <boss@example.com>'],
      bcc: [...opened.bcc, 'archive@example.com'],
    };
    const swapped = swapAccountFields({ fields: added, auto: opened.auto, lists: lists() });
    assert.deepEqual(swapped.cc, ['Boss Person <boss@example.com>']);
    assert.deepEqual(swapped.bcc, ['archive@example.com']);
  });

  it('keeps a named chip the user typed after removing the automatic chip for that address', () => {
    const opened = openAutoRecipients(fields({ to: ['x@example.com'] }), lists({ cc: ['boss@example.com'] }));
    const retyped = { ...opened, cc: ['Boss Person <boss@example.com>'] };
    const swapped = swapAccountFields({ fields: retyped, auto: opened.auto, lists: lists() });
    assert.deepEqual(swapped.cc, ['Boss Person <boss@example.com>']);
  });

  it('does not re-add an address the user removed when both accounts list it', () => {
    const shared = lists({ cc: ['crm@example.com'] });
    const opened = openAutoRecipients(fields({ to: ['x@example.com'] }), shared);
    assert.deepEqual(opened.cc, ['crm@example.com']);
    const removed = without(opened, 'cc', 'crm@example.com');
    assert.deepEqual(swapAccountFields({ fields: removed, auto: opened.auto, lists: shared }).cc, []);
  });

  it('does not re-add a removed address on a switch from A to B and back to A', () => {
    const opened = openAutoRecipients(fields({ to: ['x@example.com'] }), A);
    const removed = without(opened, 'bcc', 'a@example.com');
    const toB = swapAccountFields({ fields: removed, auto: opened.auto, lists: B });
    assert.deepEqual(toB.bcc, ['b@example.com']);
    const backToA = swapAccountFields({ fields: toB, auto: toB.auto, lists: A });
    assert.deepEqual(backToA.bcc, []);
  });

  it('puts an address in both of the new account\'s lists in Cc only', () => {
    const opened = openAutoRecipients(fields({ to: ['x@example.com'] }), lists());
    const swapped = swapAccountFields({ fields: opened, auto: opened.auto, lists: lists({ cc: ['me@example.com'], bcc: ['me@example.com'] }) });
    assert.deepEqual([swapped.cc, swapped.bcc], [['me@example.com'], []]);
  });

  it('leaves the fields as the same arrays when neither account has lists', () => {
    const opened = openAutoRecipients(fields({ to: ['x@example.com'], cc: ['c@example.com'], bcc: ['u@example.com'] }), lists());
    const swapped = swapAccountFields({ fields: opened, auto: opened.auto, lists: lists() });
    assert.equal(swapped.cc, opened.cc);
    assert.equal(swapped.bcc, opened.bcc);
  });
});

describe('splitAddressInput', () => {
  it('splits on commas, semicolons and whitespace and drops empty entries', () => {
    assert.deepEqual(splitAddressInput(' a@example.com; b@example.org ,\n c@example.invalid,'), ['a@example.com', 'b@example.org', 'c@example.invalid']);
    assert.deepEqual(splitAddressInput(''), []);
    assert.deepEqual(splitAddressInput(undefined), []);
  });

  it('passes a malformed entry through as typed so the server can reject it by name', () => {
    assert.deepEqual(splitAddressInput('foo, A@Example.com'), ['foo', 'A@Example.com']);
  });
});

describe('autoRecipientFields', () => {
  it('always returns both lists, sending the saved ones back when nothing was edited', () => {
    assert.deepEqual(
      autoRecipientFields({ auto_cc_addresses: ['boss@example.com'], auto_bcc_addresses: [] }),
      { auto_cc_addresses: ['boss@example.com'], auto_bcc_addresses: [] },
    );
    assert.deepEqual(autoRecipientFields({}), { auto_cc_addresses: [], auto_bcc_addresses: [] });
  });

  it('prefers the edited text over the saved list, and an emptied field clears it', () => {
    assert.deepEqual(
      autoRecipientFields({
        auto_cc_addresses: ['old@example.com'], auto_cc_text: 'new@example.com, other@example.com',
        auto_bcc_addresses: ['me@example.com'], auto_bcc_text: '',
      }),
      { auto_cc_addresses: ['new@example.com', 'other@example.com'], auto_bcc_addresses: [] },
    );
  });
});
