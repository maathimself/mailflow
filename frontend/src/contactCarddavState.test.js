import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADDITIONAL_FIELD_KINDS,
  beginPhotoRead,
  canUploadContactPhoto,
  completePhotoRead,
  contactCarddavState,
  contactToForm,
  formToContactDraft,
  initialPhotoReadState,
  invalidatePhotoRead,
  isRefreshableWriteError,
  newAdditionalField,
  removeContactPhoto,
  saveFailureState,
  shouldRefreshContactAfterResolution,
  validateContactPhoto,
} from './contactCarddavState.js';
import * as contactCarddavHelpers from './contactCarddavState.js';
import { api } from './utils/api.js';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('CardDAV contact state', () => {
  it('labels writable, operation-read-only, and conflicted contacts from backend capabilities', () => {
    assert.deepEqual(contactCarddavState({
      sync_state: 'synced',
      remote_update_capability: 'allowed',
      remote_delete_capability: 'denied',
    }), {
      labelKey: 'contacts.carddavSynced',
      canEdit: true,
      canDelete: false,
      conflictId: null,
    });
    assert.deepEqual(contactCarddavState({
      sync_state: 'synced',
      remote_update_capability: 'denied',
      remote_delete_capability: 'denied',
    }), {
      labelKey: 'contacts.carddavReadOnly',
      canEdit: false,
      canDelete: false,
      conflictId: null,
    });
    assert.deepEqual(contactCarddavState({
      sync_state: 'conflict',
      conflict_id: 'conflict-1',
      remote_update_capability: 'allowed',
      remote_delete_capability: 'allowed',
    }), {
      labelKey: 'contacts.carddavConflict',
      canEdit: false,
      canDelete: false,
      conflictId: 'conflict-1',
    });
  });

  it('marks a write-unconfirmed contact as pending, not fully synced, and keeps it editable', () => {
    // pending_push is the only pending sync_state the contacts API can surface.
    assert.deepEqual(contactCarddavState({
      sync_state: 'pending_push',
      remote_update_capability: 'allowed',
      remote_delete_capability: 'allowed',
    }), {
      labelKey: 'contacts.carddavPending',
      canEdit: true,
      canDelete: true,
      conflictId: null,
    });
    // A conflict still wins over pending, and a denied capability still gates the action.
    assert.equal(contactCarddavState({ sync_state: 'pending_push', conflict_id: 'c1' }).labelKey,
      'contacts.carddavConflict');
    assert.equal(contactCarddavState({
      sync_state: 'pending_push',
      remote_update_capability: 'denied',
      remote_delete_capability: 'denied',
    }).canEdit, false);
    // A genuinely synced contact is unchanged.
    assert.equal(contactCarddavState({ sync_state: 'synced', remote_update_capability: 'allowed' }).labelKey,
      'contacts.carddavSynced');
  });

  it('initializes an editable form without dropping photos or typed Additional fields', () => {
    const contact = {
      display_name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
      emails: [{ value: 'ada@example.test', type: 'work', primary: true }],
      phones: [{ value: '+1 555 0100', type: 'mobile' }],
      organization: 'Analytical Engines',
      notes: 'First programmer',
      photo_data: 'data:image/png;base64,AQID',
      has_photo: true,
      sync_state: 'synced',
      remote_create_capability: 'allowed',
      remote_update_capability: 'unknown',
      remote_delete_capability: 'denied',
      conflict_id: 'conflict-1',
      additional_fields: [{
        id: 'stable-site',
        kind: 'url',
        label: 'Portfolio',
        value: 'https://example.test/ada',
        vcard: {
          group: 'item1',
          name: 'URL',
          parameters: { TYPE: ['work'] },
        },
      }],
    };
    const editableAdditionalFields = [{
      id: 'stable-site',
      kind: 'url',
      label: 'Portfolio',
      value: 'https://example.test/ada',
    }];

    const form = contactToForm(contact);
    assert.equal(form.photoData, contact.photo_data);
    assert.equal(form.hasPhoto, true);
    assert.deepEqual(form.carddav, {
      syncState: 'synced',
      capabilities: { create: 'allowed', update: 'unknown', delete: 'denied' },
      conflictId: 'conflict-1',
    });
    assert.deepEqual(form.additionalFields, editableAdditionalFields);
    assert.notEqual(form.additionalFields, contact.additional_fields);
    assert.equal(JSON.stringify(form.additionalFields).includes('vcard'), false);
    assert.deepEqual(formToContactDraft(form), {
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      emails: contact.emails,
      phones: contact.phones,
      organization: 'Analytical Engines',
      notes: 'First programmer',
      photoData: contact.photo_data,
      additionalFields: editableAdditionalFields,
    });
    assert.equal(JSON.stringify(formToContactDraft(form)).includes('parameters'), false);
  });

  it('supports every projected Additional-field kind and gives new fields stable IDs', () => {
    assert.deepEqual(ADDITIONAL_FIELD_KINDS, [
      'postal-address', 'url', 'im', 'birthday', 'anniversary', 'date',
      'role', 'title', 'nickname', 'geo', 'custom-text',
    ]);

    const field = newAdditionalField('im', () => 'stable-generated-id');
    assert.deepEqual(field, {
      id: 'stable-generated-id',
      kind: 'im',
      label: '',
      value: { protocol: '', handle: '' },
    });
  });

  it('round-trips valid vCard date shapes through lossless text controls', () => {
    const additionalFields = [
      { id: 'basic', kind: 'birthday', label: 'Basic', value: '19960415' },
      { id: 'partial', kind: 'anniversary', label: 'Partial', value: '--0415' },
      { id: 'date-time', kind: 'date', label: 'Date-time', value: '19960415T143000Z' },
      { id: 'text', kind: 'birthday', label: 'Text', value: 'circa 1996' },
    ];

    const form = contactToForm({ additional_fields: additionalFields });

    assert.deepEqual(form.additionalFields.map(field => field.value), [
      '19960415', '--0415', '19960415T143000Z', 'circa 1996',
    ]);
    assert.equal(typeof contactCarddavHelpers.additionalFieldInputType, 'function');
    assert.deepEqual(form.additionalFields.map(field => ({
      type: contactCarddavHelpers.additionalFieldInputType(field.kind),
      value: field.value,
    })), additionalFields.map(field => ({ type: 'text', value: field.value })));
    assert.deepEqual(formToContactDraft(form).additionalFields, additionalFields);

    const contactsPage = readFileSync(join(testDir, 'components', 'ContactsPage.jsx'), 'utf8');
    assert.match(contactsPage, /type=\{additionalFieldInputType\(field\.kind\)\}/);
  });

  it('keeps contact status and actions in a wrapping in-flow header', () => {
    const contactsPage = readFileSync(join(testDir, 'components', 'ContactsPage.jsx'), 'utf8');
    const detail = contactsPage.slice(
      contactsPage.indexOf('function ContactDetail'),
      contactsPage.indexOf('function ContactForm'),
    );

    assert.match(detail, /flexWrap: 'wrap'/);
    assert.doesNotMatch(detail, /paddingRight: 128/);
  });

  it('marks photo removal explicitly and rejects oversized or non-image uploads', () => {
    assert.deepEqual(removeContactPhoto({
      photoData: 'data:image/jpeg;base64,AQID',
      hasPhoto: true,
      displayName: 'Ada',
    }), {
      photoData: null,
      hasPhoto: false,
      displayName: 'Ada',
    });
    assert.equal(validateContactPhoto({ type: 'image/png', size: 512 * 1024 }), null);
    assert.equal(validateContactPhoto({ type: 'image/svg+xml', size: 100 }), 'contacts.photo.invalidType');
    assert.equal(validateContactPhoto({ type: 'image/jpeg', size: 512 * 1024 + 1 }), 'contacts.photo.tooLarge');
  });

  it('offers the detail-view photo upload only where the remote accepts an update', () => {
    assert.equal(canUploadContactPhoto({ id: 1 }), true);
    assert.equal(canUploadContactPhoto({
      sync_state: 'synced',
      remote_update_capability: 'allowed',
      remote_delete_capability: 'denied',
    }), true);
    assert.equal(canUploadContactPhoto({
      sync_state: 'pending_push',
      remote_update_capability: 'allowed',
    }), true);
    assert.equal(canUploadContactPhoto({
      sync_state: 'synced',
      remote_update_capability: 'denied',
    }), false);
    assert.equal(canUploadContactPhoto({ sync_state: 'conflict', conflict_id: 'conflict-1' }), false);
    assert.equal(canUploadContactPhoto(null), false);
  });

  it('uploads the detail-view photo from a focusable control through the edit save path', () => {
    const contactsPage = readFileSync(join(testDir, 'components', 'ContactsPage.jsx'), 'utf8');
    const detail = contactsPage.slice(
      contactsPage.indexOf('function ContactDetail'),
      contactsPage.indexOf('function ContactForm'),
    );

    assert.match(detail, /canUploadContactPhoto\(c\)/);
    assert.match(detail, /<button/);
    assert.match(detail, /photoInputRef\.current\?\.click\(\)/);
    assert.doesNotMatch(detail, /<div[^>]*onClick/);
    assert.match(contactsPage, /const uploadDetailPhoto = file =>/);
    assert.match(contactsPage, /readPhotoFile\(file, photoData => submitContact\(/);
  });

  it('keeps photo reading pending and ignores a callback after the form changes', () => {
    const reading = beginPhotoRead(initialPhotoReadState());
    assert.equal(reading.pending, true);

    const changedForm = invalidatePhotoRead(reading);
    assert.equal(changedForm.pending, false);
    assert.equal(changedForm.generation, reading.generation + 1);
    assert.deepEqual(completePhotoRead(changedForm, reading.generation), {
      state: changedForm,
      accepted: false,
    });
  });

  it('accepts only the newest photo read callback', () => {
    const first = beginPhotoRead(initialPhotoReadState());
    const second = beginPhotoRead(first);

    assert.deepEqual(completePhotoRead(second, first.generation), {
      state: second,
      accepted: false,
    });
    assert.deepEqual(completePhotoRead(second, second.generation), {
      state: { generation: second.generation, pending: false },
      accepted: true,
    });
  });

  it('navigates a 409 to its conflict while retaining the exact draft object', () => {
    const form = { displayName: 'Unsaved edit' };
    const error = Object.assign(new Error('Request failed'), {
      status: 409,
      conflictId: 'conflict-1',
    });

    assert.deepEqual(saveFailureState(error, form), {
      view: 'conflict',
      conflictId: 'conflict-1',
      form,
      error: null,
    });
    assert.equal(saveFailureState(error, form).form, form);
  });

  it('routes a 409 ambiguous/pending write to a refresh view that keeps the draft', () => {
    const form = { displayName: 'Unsaved edit' };
    for (const code of ['ERR_CARDDAV_AMBIGUOUS_WRITE', 'ERR_CARDDAV_PENDING_INTENT']) {
      const error = Object.assign(new Error('unconfirmed'), {
        status: 409,
        data: { error: 'unconfirmed', code, refresh: true },
      });
      assert.equal(isRefreshableWriteError(error), true);
      assert.deepEqual(saveFailureState(error, form), {
        view: 'refresh',
        conflictId: null,
        form,
        error: null,
        messageKey: 'contacts.carddavWriteUnconfirmed',
      });
      assert.equal(saveFailureState(error, form).form, form);
    }
    // A conflictId 409 still routes to conflict; other errors stay a form error.
    const conflict = Object.assign(new Error('x'), { status: 409, conflictId: 'c1' });
    assert.equal(isRefreshableWriteError(conflict), false);
    assert.equal(saveFailureState(conflict, form).view, 'conflict');
    assert.equal(saveFailureState(Object.assign(new Error('boom'), { status: 500 }), form).view, 'form');
  });

  it('refreshes only the selected contact represented by the resolved conflict', () => {
    const conflict = {
      local: { tombstone: true, contact: null },
      remote: { tombstone: false, contact: { uid: 'contact-1' } },
    };

    assert.equal(shouldRefreshContactAfterResolution({ uid: 'contact-1' }, conflict), true);
    assert.equal(shouldRefreshContactAfterResolution({ uid: 'contact-2' }, conflict), false);
    assert.equal(shouldRefreshContactAfterResolution(null, conflict), false);
  });

  it('preserves HTTP 409 metadata needed for conflict navigation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ conflictId: 'conflict-1' }),
    });

    try {
      await assert.rejects(api.updateContact('contact-1', { displayName: 'Draft' }), error => {
        assert.equal(error.status, 409);
        assert.equal(error.conflictId, 'conflict-1');
        assert.deepEqual(error.data, { conflictId: 'conflict-1' });
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
