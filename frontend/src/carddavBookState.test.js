import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardDavBookCapability,
  cardDavBookControls,
  cardDavBookRole,
  publishEmailedContactsToggle,
} from './carddavBookState.js';

describe('CardDAV per-book role view-model', () => {
  it('labels the role by the most-privileged flag set', () => {
    assert.equal(cardDavBookRole({ isWriteTarget: true, isSubscribed: true, isLookupSource: true }), 'writeTarget');
    assert.equal(cardDavBookRole({ isWriteTarget: false, isSubscribed: true, isLookupSource: true }), 'subscribed');
    assert.equal(cardDavBookRole({ isWriteTarget: false, isSubscribed: false, isLookupSource: true }), 'lookupOnly');
    assert.equal(cardDavBookRole({ isWriteTarget: false, isSubscribed: false, isLookupSource: false }), 'ignored');
  });

  it('derives the capability badge from observed write capabilities', () => {
    assert.equal(cardDavBookCapability({ capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' } }), 'writable');
    assert.equal(cardDavBookCapability({ capabilities: { create: 'denied', update: 'denied', delete: 'denied' } }), 'readOnly');
    assert.equal(cardDavBookCapability({ capabilities: { create: 'unknown', update: 'allowed', delete: 'allowed' } }), 'unknownCapability');
    // No capabilities object at all reads as unknown, not a crash.
    assert.equal(cardDavBookCapability({}), 'unknownCapability');
  });

  it('renders the write-target row with its Subscribe toggle locked on', () => {
    const controls = cardDavBookControls({
      isWriteTarget: true,
      isSubscribed: true,
      isLookupSource: true,
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    });
    assert.deepEqual(controls, {
      role: 'writeTarget',
      capability: 'writable',
      subscribeChecked: true,
      lookupChecked: true,
      isWriteTarget: true,
      writeTargetDisabled: false,
      subscribeDisabled: true,
    });
  });

  it('disables the write-target radio for a create-denied lookup-only book', () => {
    const controls = cardDavBookControls({
      isWriteTarget: false,
      isSubscribed: false,
      isLookupSource: true,
      capabilities: { create: 'denied', update: 'denied', delete: 'denied' },
    });
    assert.deepEqual(controls, {
      role: 'lookupOnly',
      capability: 'readOnly',
      subscribeChecked: false,
      lookupChecked: true,
      isWriteTarget: false,
      writeTargetDisabled: true,
      subscribeDisabled: false,
    });
  });

  it('lets a subscribed secondary be toggled and promoted (radio enabled, subscribe unlocked)', () => {
    const controls = cardDavBookControls({
      isWriteTarget: false,
      isSubscribed: true,
      isLookupSource: true,
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    });
    assert.equal(controls.role, 'subscribed');
    assert.equal(controls.subscribeDisabled, false);
    assert.equal(controls.writeTargetDisabled, false);
    assert.equal(controls.subscribeChecked, true);
  });
});

describe('publish-emailed-contacts toggle', () => {
  // Every connection made before this setting existed has no such key, and a
  // status the panel has not loaded yet is null. Neither is consent: the toggle
  // reads OFF, so the panel never shows "publishing everyone you email" to a user
  // who never asked for it.
  it('reads OFF when the setting is absent, so it is never enabled by default', () => {
    for (const status of [undefined, null, {}, { connected: true }]) {
      assert.deepEqual(publishEmailedContactsToggle(status), {
        checked: false,
        patch: { publishEmailedContacts: true },
      });
    }
  });

  it('reads ON only for an explicit true, never a merely truthy value', () => {
    assert.equal(publishEmailedContactsToggle({ publishEmailedContacts: true }).checked, true);
    assert.equal(publishEmailedContactsToggle({ publishEmailedContacts: false }).checked, false);
    assert.equal(publishEmailedContactsToggle({ publishEmailedContacts: 'yes' }).checked, false);
    assert.equal(publishEmailedContactsToggle({ publishEmailedContacts: 1 }).checked, false);
  });

  it('sends the inverted value as the patch', () => {
    assert.deepEqual(publishEmailedContactsToggle({ publishEmailedContacts: true }).patch,
      { publishEmailedContacts: false });
    assert.deepEqual(publishEmailedContactsToggle({ publishEmailedContacts: false }).patch,
      { publishEmailedContacts: true });
  });
});
