import { describe, expect, it } from 'vitest';
import { planAutomaticProjection } from './carddavProjection.js';

const remoteObject = (name, overrides = {}) => {
  const object = {
    href: `https://dav.example.test/book/${name}.vcf`,
    discoveryIndex: 0,
    contact: {
      uid: name,
      primaryEmail: `${name}@example.com`,
    },
  };
  return {
    ...object,
    ...overrides,
    contact: { ...object.contact, ...overrides.contact },
  };
};

const localContact = (id, overrides = {}) => ({
  id,
  isAuto: false,
  uid: `local-${id}`,
  primaryEmail: `${id}@example.com`,
  ...overrides,
});

describe('planAutomaticProjection', () => {
  it('keeps an existing mapping before considering automatic matches', () => {
    const remote = remoteObject('mapped', {
      contact: { uid: 'shared-uid', primaryEmail: 'shared@example.com' },
    });
    expect(planAutomaticProjection({
      remoteObjects: [remote],
      mappings: [{ href: remote.href, localContactId: 'mapped-local' }],
      localContacts: [
        localContact('mapped-local'),
        localContact('unmapped-match', {
          uid: 'shared-uid', primaryEmail: 'shared@example.com',
        }),
      ],
    })).toEqual({
      links: [{ href: remote.href, localContactId: 'mapped-local' }],
      imports: [],
      exports: [{ localContactId: 'unmapped-match' }],
    });
  });

  it('links by one exact non-blank UID before a primary-email candidate', () => {
    const remote = remoteObject('uid-first', {
      contact: { uid: 'stable-uid', primaryEmail: 'email-match@example.com' },
    });
    expect(planAutomaticProjection({
      remoteObjects: [remote],
      mappings: [],
      localContacts: [
        localContact('email-match', { primaryEmail: ' EMAIL-MATCH@example.com ' }),
        localContact('uid-match', { uid: 'stable-uid', primaryEmail: 'other@example.com' }),
      ],
    })).toEqual({
      links: [{ href: remote.href, localContactId: 'uid-match' }],
      imports: [],
      exports: [{ localContactId: 'email-match' }],
    });
  });

  it('links only one normalized primary-email candidate', () => {
    const unique = remoteObject('unique', {
      contact: { uid: 'remote-unique', primaryEmail: ' UNIQUE@example.com ' },
    });
    const ambiguous = remoteObject('ambiguous', {
      contact: { uid: 'remote-ambiguous', primaryEmail: 'shared@example.com' },
    });
    expect(planAutomaticProjection({
      remoteObjects: [ambiguous, unique],
      mappings: [],
      localContacts: [
        localContact('unique', { uid: 'local-unique', primaryEmail: 'unique@EXAMPLE.COM' }),
        localContact('shared-a', { uid: 'local-a', primaryEmail: 'shared@example.com' }),
        localContact('shared-b', { uid: 'local-b', primaryEmail: ' SHARED@example.com ' }),
      ],
    })).toEqual({
      links: [{ href: unique.href, localContactId: 'unique' }],
      imports: [{ href: ambiguous.href }],
      exports: [{ localContactId: 'shared-a' }, { localContactId: 'shared-b' }],
    });
  });

  it('never matches prohibited fields, blanks, or auto contacts', () => {
    const remote = remoteObject('prohibited', {
      contact: {
        uid: ' ', primaryEmail: '', displayName: 'Same',
        phones: [{ value: '+15550000001' }], organization: 'Same Org',
      },
    });
    expect(planAutomaticProjection({
      remoteObjects: [remote],
      mappings: [],
      localContacts: [
        localContact('explicit', {
          uid: '', primaryEmail: '', displayName: 'Same',
          phones: [{ value: '+15550000001' }], organization: 'Same Org',
        }),
        localContact('auto', {
          uid: ' ', primaryEmail: '', displayName: 'Same', isAuto: true,
        }),
      ],
    })).toEqual({
      links: [],
      imports: [{ href: remote.href }],
      exports: [{ localContactId: 'explicit' }],
    });
  });

  it('does not link an ambiguous UID or reuse one local contact', () => {
    const first = remoteObject('a', {
      contact: { uid: 'shared-uid', primaryEmail: 'a@example.com' },
    });
    const second = remoteObject('b', {
      contact: { uid: 'shared-uid', primaryEmail: 'b@example.com' },
    });
    expect(planAutomaticProjection({
      remoteObjects: [second, first],
      mappings: [],
      localContacts: [
        localContact('candidate-a', { uid: 'shared-uid', primaryEmail: 'none-a@example.com' }),
        localContact('candidate-b', { uid: 'shared-uid', primaryEmail: 'none-b@example.com' }),
      ],
    })).toEqual({
      links: [],
      imports: [{ href: first.href }, { href: second.href }],
      exports: [{ localContactId: 'candidate-a' }, { localContactId: 'candidate-b' }],
    });
  });

  it('orders books, hrefs, and local IDs without mutating inputs', () => {
    const remoteObjects = [
      remoteObject('z', { discoveryIndex: 2 }),
      remoteObject('b', { discoveryIndex: 0 }),
      remoteObject('a', { discoveryIndex: 0 }),
    ];
    const mappings = [];
    const localContacts = [localContact('z-local'), localContact('a-local')];
    const before = structuredClone({ remoteObjects, mappings, localContacts });
    expect(planAutomaticProjection({ remoteObjects, mappings, localContacts })).toEqual({
      links: [],
      imports: [
        { href: remoteObjects[2].href },
        { href: remoteObjects[1].href },
        { href: remoteObjects[0].href },
      ],
      exports: [{ localContactId: 'a-local' }, { localContactId: 'z-local' }],
    });
    expect({ remoteObjects, mappings, localContacts }).toEqual(before);
  });
});
