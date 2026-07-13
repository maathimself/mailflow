import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSenderOptions,
  resolveSenderOrFallback,
  resolveSenderSignature,
  senderToValue,
  valueToSender,
  wildcardCovers,
} from './senderIdentity.js';

test('passes a successful sender resolution through unchanged', async () => {
  const resolved = { sender: { accountId: 'a1', aliasId: null, fromEmail: null }, requiresSelection: false };
  assert.deepEqual(await resolveSenderOrFallback(() => Promise.resolve(resolved)), resolved);
});

test('degrades to manual sender selection when resolution rejects', async () => {
  assert.deepEqual(
    await resolveSenderOrFallback(() => Promise.reject(new Error('resolve failed'))),
    { sender: null, requiresSelection: true },
  );
});

test('round-trips a wildcard-derived exact From address', () => {
  const sender = { accountId: 'a1', aliasId: 'wild1', fromEmail: 'mask+tag@example.com' };
  assert.deepEqual(valueToSender(senderToValue(sender)), sender);
});

test('round-trips an explicit primary sender without inventing an alias', () => {
  const sender = { accountId: 'account:with:opaque-id', aliasId: null, fromEmail: null };
  assert.deepEqual(valueToSender(senderToValue(sender)), sender);
});

test('does not invent a primary sender for an unresolved reply', () => {
  assert.equal(senderToValue(null), '');
  assert.equal(valueToSender(''), null);
});

test('uses a stale resolved sender signature while that sender remains selected', () => {
  const account = { id: 'a1', signature: '<p>Account signature</p>', aliases: [] };
  const resolvedSender = {
    accountId: 'a1',
    aliasId: 'stale-alias',
    fromEmail: null,
    signature: '<p>Alias signature</p>',
  };

  assert.equal(resolveSenderSignature({
    account,
    alias: null,
    selectedSender: valueToSender(senderToValue(resolvedSender)),
    resolvedSender,
  }), '<p>Alias signature</p>');
});

test('wildcard coverage is case-insensitive and restricted to the exact domain', () => {
  assert.equal(wildcardCovers('*@Example.com', 'Mask@EXAMPLE.COM'), true);
  assert.equal(wildcardCovers('*@example.com', 'mask@sub.example.com'), false);
  assert.equal(wildcardCovers('example.com', 'mask@example.com'), false);
});

test('builds exact visible sender options and backs mask-only rows with verified wildcards', () => {
  const account = {
    id: 'a1', name: 'Fastmail', sender_name: 'Account Owner', email_address: 'owner@example.com',
    aliases: [
      { id: 'manual', name: 'Manual', email: 'manual@example.com', provenance: 'manual', fastmail_identity_id: null },
      { id: 'exact', name: 'Exact', email: 'exact@example.com', provenance: 'fastmail', fastmail_identity_id: 'i1' },
      { id: 'wild', name: 'Wildcard', email: '*@example.com', provenance: 'fastmail', fastmail_identity_id: 'i2' },
      { id: 'mask', name: 'Masked row', email: 'mask@example.com', provenance: 'fastmail', fastmail_identity_id: null },
      { id: 'unverified-wild', name: 'Unverified', email: '*@other.example', provenance: 'fastmail', fastmail_identity_id: null },
      { id: 'unverified-mask', name: 'Unverified mask', email: 'mask@other.example', provenance: 'fastmail', fastmail_identity_id: null },
    ],
  };

  assert.deepEqual(buildSenderOptions(account), [
    {
      label: 'Account Owner <owner@example.com>',
      sender: { accountId: 'a1', aliasId: null, fromEmail: null },
    },
    {
      label: 'Manual <manual@example.com>',
      sender: { accountId: 'a1', aliasId: 'manual', fromEmail: null },
    },
    {
      label: 'Exact <exact@example.com>',
      sender: { accountId: 'a1', aliasId: 'exact', fromEmail: null },
    },
    {
      label: 'Wildcard <mask@example.com>',
      sender: { accountId: 'a1', aliasId: 'wild', fromEmail: 'mask@example.com' },
    },
  ]);
});

test('includes a resolved exact alias when the frontend account aliases are stale', () => {
  const account = {
    id: 'fastmail',
    name: 'Fastmail',
    sender_name: 'Test Account',
    email_address: 'primary@fastmail.example',
    aliases: [],
  };
  const resolvedSender = {
    accountId: 'fastmail',
    aliasId: 'unnamed-identity',
    fromEmail: null,
    displayEmail: 'unnamed@fastmail.example',
    name: 'Test Account',
    provenance: 'fastmail',
  };

  assert.deepEqual(buildSenderOptions(account, resolvedSender), [
    {
      label: 'Test Account <primary@fastmail.example>',
      sender: { accountId: 'fastmail', aliasId: null, fromEmail: null },
    },
    {
      label: 'Test Account <unnamed@fastmail.example>',
      sender: resolvedSender,
    },
  ]);
});

test('renders a blank Fastmail identity name as an address-only sender option', () => {
  const account = {
    id: 'fastmail',
    name: 'Fastmail',
    sender_name: 'Test Account',
    email_address: 'primary@fastmail.example',
    aliases: [{
      id: 'unnamed-identity',
      name: '',
      email: 'unnamed@fastmail.example',
      provenance: 'fastmail',
      fastmail_identity_id: 'identity-unnamed',
    }],
  };

  assert.equal(buildSenderOptions(account)[1].label, 'unnamed@fastmail.example');
});

test('renders a stale resolved sender with a blank identity name as address-only', () => {
  const account = {
    id: 'fastmail',
    name: 'Fastmail',
    sender_name: 'Test Account',
    email_address: 'primary@fastmail.example',
    aliases: [],
  };
  const resolvedSender = {
    accountId: 'fastmail',
    aliasId: 'unnamed-identity',
    fromEmail: null,
    displayEmail: 'unnamed@fastmail.example',
    name: '',
    provenance: 'fastmail',
  };

  assert.equal(buildSenderOptions(account, resolvedSender)[1].label, 'unnamed@fastmail.example');
});
