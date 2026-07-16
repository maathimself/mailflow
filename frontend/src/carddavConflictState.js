export const CARDDAV_RESOLUTIONS = ['keep-mailflow', 'keep-carddav'];

export const CONFLICT_FIELD_ORDER = [
  'displayName',
  'firstName',
  'lastName',
  'emails',
  'phones',
  'organization',
  'notes',
  'additionalFields',
  'photo',
];

export const CONFLICT_FIELD_LABELS = {
  displayName: 'contacts.fields.displayName',
  firstName: 'contacts.fields.firstName',
  lastName: 'contacts.fields.lastName',
  emails: 'contacts.fields.email',
  phones: 'contacts.fields.phone',
  organization: 'contacts.fields.organization',
  notes: 'contacts.fields.notes',
  additionalFields: 'contacts.additional.title',
  photo: 'contacts.photo.title',
};

function sortedEntries(entries, fields) {
  return (entries || [])
    .map(entry => Object.fromEntries(fields.map(field => [field, entry?.[field] ?? ''])))
    .sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
}

function normalizedValue(contact, key) {
  if (key === 'emails') {
    return sortedEntries(contact?.emails, ['value', 'type', 'primary']);
  }
  if (key === 'phones') {
    return sortedEntries(contact?.phones, ['value', 'type']);
  }
  if (key === 'additionalFields') {
    return cloneFields(contact?.additionalFields)
      .map(field => Object.fromEntries(
        Object.entries(field).map(([fieldKey, value]) => [fieldKey, value ?? '']),
      ))
      .sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
  }
  return contact?.[key] ?? '';
}

function comparisonCell(side, key) {
  if (side?.tombstone) return { kind: 'tombstone' };
  if (key === 'photo') return { kind: 'photo', present: Boolean(side?.hasPhoto) };
  return { kind: 'value', value: normalizedValue(side?.contact, key) };
}

export function conflictComparison(conflict) {
  return CONFLICT_FIELD_ORDER.map(key => ({
    key,
    local: comparisonCell(conflict?.local, key),
    remote: comparisonCell(conflict?.remote, key),
  }));
}

export function initialConflictQueueState(conflicts, selectedId = null) {
  const countKnown = Array.isArray(conflicts);
  const unresolved = (conflicts || []).filter(conflict => conflict.status !== 'resolved');
  const selected = unresolved.some(conflict => conflict.id === selectedId)
    ? selectedId
    : unresolved[0]?.id ?? null;
  return {
    conflicts: unresolved,
    selectedId: selected,
    pendingResolution: null,
    errorKey: null,
    countKnown,
    loadGeneration: 0,
    loading: false,
    loadError: false,
    resolutionApplied: false,
  };
}

export function beginConflictLoad(state) {
  return {
    ...state,
    loadGeneration: state.loadGeneration + 1,
    loading: true,
    loadError: false,
  };
}

export function completeConflictLoad(state, generation, conflicts, selectedId = null) {
  if (generation !== state.loadGeneration) return state;
  const loaded = initialConflictQueueState(conflicts, selectedId || state.selectedId);
  return {
    ...loaded,
    pendingResolution: state.resolutionApplied ? null : state.pendingResolution,
    errorKey: state.resolutionApplied ? null : state.errorKey,
    loadGeneration: state.loadGeneration,
  };
}

export function failConflictLoad(state, generation) {
  if (generation !== state.loadGeneration) return state;
  return {
    ...state,
    pendingResolution: state.resolutionApplied ? null : state.pendingResolution,
    errorKey: state.resolutionApplied
      ? 'contacts.conflicts.resolveFailed'
      : state.errorKey,
    loading: false,
    loadError: true,
    resolutionApplied: false,
  };
}

export function beginConflictResolution(state, resolution) {
  if (!CARDDAV_RESOLUTIONS.includes(resolution)) throw new TypeError('Unsupported conflict resolution');
  return { ...state, pendingResolution: resolution, errorKey: null };
}

export function failConflictResolution(state) {
  return {
    ...state,
    pendingResolution: null,
    errorKey: 'contacts.conflicts.resolveFailed',
    resolutionApplied: false,
  };
}

export function completeConflictResolution(state) {
  return {
    ...state,
    resolutionApplied: true,
  };
}
import { cloneFields } from './contactCarddavState.js';
