export const ADDITIONAL_FIELD_KINDS = [
  'postal-address',
  'url',
  'im',
  'birthday',
  'anniversary',
  'date',
  'role',
  'title',
  'nickname',
  'geo',
  'custom-text',
];

export function additionalFieldInputType(kind) {
  return kind === 'url' ? 'url' : 'text';
}

const MAX_PHOTO_BYTES = 512 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png']);

function isCardDavContact(contact) {
  return contact?.sync_state && contact.sync_state !== 'local';
}

// Mapping statuses that mean "a write is submitted but not yet confirmed by the remote"
// (it reconciles on the next sync) and must not read as fully synced. A Set (not a single
// string) so any additional pending status the contacts API can surface is handled
// generically. Only pending_push is reachable today: the contacts endpoints join
// carddav_remote_objects WHERE mapping_status <> 'pending_materialization', so a
// pending_materialization mapping reads as sync_state 'local', never pending_materialization.
const PENDING_SYNC_STATES = new Set(['pending_push']);

export function contactCarddavState(contact) {
  if (!isCardDavContact(contact)) {
    return { labelKey: null, canEdit: true, canDelete: true, conflictId: null };
  }

  const conflictId = contact.conflict_id || null;
  if (contact.sync_state === 'conflict' || conflictId) {
    return {
      labelKey: 'contacts.carddavConflict',
      canEdit: false,
      canDelete: false,
      conflictId,
    };
  }

  const canEdit = contact.remote_update_capability !== 'denied';
  const canDelete = contact.remote_delete_capability !== 'denied';
  if (PENDING_SYNC_STATES.has(contact.sync_state)) {
    // A distinct pending marker: the contact stays editable (a re-edit is fenced by the
    // backend's pending-intent handling), it just is not fully synced yet.
    return { labelKey: 'contacts.carddavPending', canEdit, canDelete, conflictId: null };
  }
  return {
    labelKey: canEdit || canDelete ? 'contacts.carddavSynced' : 'contacts.carddavReadOnly',
    canEdit,
    canDelete,
    conflictId: null,
  };
}

// The detail view's avatar uploads a photo through the same update as the edit form, so it
// is offered on exactly the contacts that update is allowed on.
export function canUploadContactPhoto(contact) {
  return Boolean(contact) && contactCarddavState(contact).canEdit;
}

const NO_PROMOTION = { visible: false, enabled: false, reasonKey: null, bookName: null };

// Promotion is the one deliberate action that turns an auto-collected contact
// into a curated one and publishes it to the CardDAV write-target book. Editing
// a harvested contact no longer does this (the backend preserves is_auto), so
// the action needs its own control rather than riding along with a field edit.
//
// Hidden when there is nothing to promote (an explicit or already-mapped
// contact) or nowhere to promote to (no CardDAV account). Shown but disabled —
// with the reason — when the account has no usable write-target, because that
// is a state the user can fix in the integration settings.
export function contactPromotionState(contact, carddav) {
  if (!contact?.is_auto || isCardDavContact(contact)) return NO_PROMOTION;
  if (!carddav?.connected) return NO_PROMOTION;

  const target = (carddav.books || []).find(book => book.isWriteTarget);
  if (!target) {
    return { visible: true, enabled: false, reasonKey: 'contacts.promote.noWriteTarget', bookName: null };
  }
  const bookName = target.name || null;
  if (target.capabilities?.create === 'denied') {
    return { visible: true, enabled: false, reasonKey: 'contacts.promote.readOnly', bookName };
  }
  return { visible: true, enabled: true, reasonKey: null, bookName };
}

// Book roles can change between the status read and the click, so a rejected
// promotion is translated from its typed code rather than echoing the backend's
// English message into a localized UI.
const PROMOTE_FAILURE_KEYS = {
  ERR_CARDDAV_NO_WRITE_TARGET: 'contacts.promote.noWriteTarget',
  ERR_CARDDAV_READ_ONLY: 'contacts.promote.readOnly',
};

export function promoteFailureKey(error) {
  return PROMOTE_FAILURE_KEYS[error?.data?.code] || 'contacts.promote.failed';
}

export function cloneFields(fields) {
  return (fields || []).map(field => ({
    id: field?.id,
    kind: field?.kind,
    label: field?.label,
    value: field?.value && typeof field.value === 'object'
      ? { ...field.value }
      : field?.value,
  }));
}

export function contactToForm(contact = {}) {
  return {
    displayName: contact.display_name || '',
    firstName: contact.first_name || '',
    lastName: contact.last_name || '',
    emails: contact.emails?.length
      ? contact.emails.map(email => ({ ...email }))
      : [{ value: '', type: 'other', primary: true }],
    phones: (contact.phones || []).map(phone => ({ ...phone })),
    organization: contact.organization || '',
    notes: contact.notes || '',
    photoData: contact.photo_data || null,
    hasPhoto: Boolean(contact.has_photo || contact.photo_data),
    additionalFields: cloneFields(contact.additional_fields),
    carddav: {
      syncState: contact.sync_state || 'local',
      capabilities: {
        create: contact.remote_create_capability || null,
        update: contact.remote_update_capability || null,
        delete: contact.remote_delete_capability || null,
      },
      conflictId: contact.conflict_id || null,
    },
  };
}

export function formToContactDraft(form) {
  const displayName = form.displayName.trim()
    || [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(' ')
    || null;
  return {
    displayName,
    firstName: form.firstName || null,
    lastName: form.lastName || null,
    emails: form.emails.filter(email => email.value.trim()),
    phones: form.phones.filter(phone => phone.value.trim()),
    organization: form.organization || null,
    notes: form.notes || null,
    photoData: form.photoData,
    additionalFields: cloneFields(form.additionalFields),
  };
}

function emptyAdditionalValue(kind) {
  if (kind === 'postal-address') {
    return {
      poBox: '',
      extendedAddress: '',
      street: '',
      locality: '',
      region: '',
      postalCode: '',
      country: '',
    };
  }
  if (kind === 'im') return { protocol: '', handle: '' };
  if (kind === 'geo') return { latitude: '', longitude: '' };
  return '';
}

export function newAdditionalField(kind, makeId = () => crypto.randomUUID()) {
  return {
    id: makeId(),
    kind,
    label: '',
    value: emptyAdditionalValue(kind),
  };
}

export function removeContactPhoto(form) {
  return { ...form, photoData: null, hasPhoto: false };
}

export function validateContactPhoto(file) {
  if (!PHOTO_TYPES.has(file?.type)) return 'contacts.photo.invalidType';
  if (file.size > MAX_PHOTO_BYTES) return 'contacts.photo.tooLarge';
  return null;
}

export function initialPhotoReadState() {
  return { generation: 0, pending: false };
}

export function beginPhotoRead(state) {
  return { generation: state.generation + 1, pending: true };
}

export function invalidatePhotoRead(state) {
  return { generation: state.generation + 1, pending: false };
}

export function completePhotoRead(state, generation) {
  if (!state.pending || state.generation !== generation) {
    return { state, accepted: false };
  }
  return {
    state: { generation: state.generation, pending: false },
    accepted: true,
  };
}

export function shouldRefreshContactAfterResolution(contact, conflict) {
  const uid = contact?.uid;
  return Boolean(uid && [
    conflict?.local?.contact?.uid,
    conflict?.remote?.contact?.uid,
  ].includes(uid));
}

// A post-write 409 whose body carries an ambiguous-write / pending-intent code: the
// remote effect may have landed and MailFlow recovered read-only, so the client must
// refresh state (re-GET) rather than blindly re-issue the mutation.
const REFRESH_WRITE_CODES = new Set([
  'ERR_CARDDAV_AMBIGUOUS_WRITE',
  'ERR_CARDDAV_PENDING_INTENT',
]);

export function isRefreshableWriteError(error) {
  return error?.status === 409 && REFRESH_WRITE_CODES.has(error?.data?.code);
}

export function saveFailureState(error, form) {
  if (error?.status === 409 && error.conflictId) {
    return {
      view: 'conflict',
      conflictId: error.conflictId,
      form,
      error: null,
    };
  }
  if (isRefreshableWriteError(error)) {
    // Keep the draft, signal the caller to re-GET the contact, and show honest copy —
    // the write may have applied and reconciles on the next sync; don't re-issue it.
    return {
      view: 'refresh',
      conflictId: null,
      form,
      error: null,
      messageKey: 'contacts.carddavWriteUnconfirmed',
    };
  }
  return {
    view: 'form',
    conflictId: null,
    form,
    error: error?.message || 'Request failed',
  };
}
