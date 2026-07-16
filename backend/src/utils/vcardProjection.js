import { createHash } from 'node:crypto';

import {
  ADR_COMPONENTS,
  SERVER_OWNED_PROPERTIES,
  VCARD_3_URI_DEFAULTS,
  VCARD_4_URI_DEFAULTS,
  canonicalSupportedPhotoDataUri,
  dataUriMimeType,
  decodeBase64Photo,
  embeddedPhotoMimeType,
  parameterValues,
  parseVCardDocument,
  photoKind,
  retainedPhotoParameters,
  serializeVCardDocument,
  splitDelimited,
  supportedPhotoMimeType,
} from './vcardDocument.js';

const ADDITIONAL_ID_PARAMETER = 'X-MAILFLOW-ID';

function unescapeText(value) {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '\\' || index + 1 >= value.length) {
      result += character;
      continue;
    }

    const next = value[++index];
    if (next === 'n' || next === 'N') result += '\n';
    else if (next === '\\' || next === ';' || next === ',' || next === ':') result += next;
    else result += '\\' + next;
  }
  return result;
}

function escapeText(value) {
  if (!value) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function escapeParam(value) {
  return String(value || '').replace(/[\r\n;:,"]/g, '');
}

function propertiesNamed(document, name) {
  return document.properties.filter(property => property.name === name);
}

function typesFor(property) {
  return parameterValues(property, 'TYPE')
    .map(value => value.trim())
    .filter(Boolean);
}

export function groupKey(group) {
  return String(group || '').toLowerCase();
}

export function primaryEmail(contact) {
  const emails = Array.isArray(contact?.emails) ? contact.emails : [];
  const primary = emails.find(email => email?.primary) ?? emails[0];
  const value = primary?.value ?? primary?.email;
  return value ? String(value).toLowerCase().trim() : null;
}

function propertyIdentityKey(property) {
  return groupKey(property?.group) + '\0' + property?.name;
}

function* propertiesWithOccurrences(document) {
  const occurrences = new Map();
  for (const [index, property] of document.properties.entries()) {
    const identityKey = propertyIdentityKey(property);
    const occurrence = occurrences.get(identityKey) || 0;
    occurrences.set(identityKey, occurrence + 1);
    yield { index, property, occurrence };
  }
}

function groupLabel(document, group) {
  if (!group) return null;
  const label = document.properties.find(property => (
    groupKey(property.group) === groupKey(group) && property.name === 'X-ABLABEL'
  ));
  if (!label) return null;
  const value = unescapeText(label.rawValue);
  return value.trim() ? value : null;
}

function projectedLabel(document, property, fallback) {
  return groupLabel(document, property.group)
    || typesFor(property).find(type => !/^(?:internet|pref)$/i.test(type))
    || fallback;
}

function stableAdditionalId(property, occurrence) {
  const identity = JSON.stringify([groupKey(property.group), property.name, occurrence]);
  return 'vcard-' + createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function additionalId(property, occurrence) {
  const identityParameters = property.params.filter(parameter => (
    String(parameter.name).toUpperCase() === ADDITIONAL_ID_PARAMETER
  ));
  if (identityParameters.length === 0) return stableAdditionalId(property, occurrence);

  const persisted = identityParameters.flatMap(parameter => parameter.values);
  if (persisted.length !== 1 || !String(persisted[0]).trim()) {
    throw new Error('vCard contains an invalid MailFlow Additional field ID');
  }
  return String(persisted[0]);
}

function hasPersistedAdditionalId(property) {
  return property.params.some(parameter => (
    String(parameter.name).toUpperCase() === ADDITIONAL_ID_PARAMETER
  ));
}

function contactAdditionalId(field) {
  return String(field?.id ?? '');
}

export function assertAdditionalIds(fields, missingError, duplicateError) {
  const ids = new Set();
  for (const field of fields) {
    const id = contactAdditionalId(field);
    if (!id.trim()) throw new Error(missingError);
    if (ids.has(id)) throw new Error(duplicateError);
    ids.add(id);
  }
}

function withAdditionalId(params, id) {
  const updated = [];
  let written = false;
  for (const parameter of params) {
    if (String(parameter.name).toUpperCase() !== ADDITIONAL_ID_PARAMETER) {
      updated.push(parameter);
    } else if (!written) {
      updated.push({ name: ADDITIONAL_ID_PARAMETER, values: [String(id ?? '')] });
      written = true;
    }
  }
  if (!written) updated.push({ name: ADDITIONAL_ID_PARAMETER, values: [String(id ?? '')] });
  return updated;
}

function additionalField(property, occurrence, kind, label, value) {
  return {
    id: additionalId(property, occurrence),
    kind,
    label,
    value,
    vcard: {
      group: property.group,
      name: property.name,
      params: structuredClone(property.params),
    },
  };
}

function parseImValue(rawValue, label) {
  const value = String(rawValue);
  const colon = value.indexOf(':');
  if (colon < 0) return { protocol: label.toLowerCase(), handle: value };

  let protocol = value.slice(0, colon).toLowerCase();
  let handle = value.slice(colon + 1);
  if (protocol === 'x-apple') {
    try {
      handle = decodeURIComponent(handle);
    } catch {
      // Keep the original handle; malformed percent encoding is opaque text.
    }
    protocol = label.toLowerCase() === 'im' ? 'x-apple' : label.toLowerCase();
  }
  return { protocol, handle };
}

function parseGeoValue(rawValue) {
  const value = unescapeText(rawValue).replace(/^geo:/i, '');
  const parts = value.split(/[;,]/);
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function additionalFieldsFromDocument(document) {
  assertUniquePersistedAdditionalIds(document);
  const fields = [];

  for (const { property, occurrence } of propertiesWithOccurrences(document)) {
    const raw = unescapeText(property.rawValue);

    switch (property.name) {
      case 'ADR': {
        const parts = splitDelimited(property.rawValue, ';').map(unescapeText);
        while (parts.length < 7) parts.push('');
        fields.push(additionalField(
          property,
          occurrence,
          'postal-address',
          projectedLabel(document, property, 'Address'),
          Object.fromEntries(ADR_COMPONENTS.map((component, index) => [component, parts[index]])),
        ));
        break;
      }
      case 'URL':
        fields.push(additionalField(
          property,
          occurrence,
          'url',
          projectedLabel(document, property, 'URL'),
          projectedPropertyValue(property, document.version),
        ));
        break;
      case 'IMPP': {
        const label = projectedLabel(document, property, 'IM');
        fields.push(additionalField(
          property,
          occurrence,
          'im',
          label,
          parseImValue(projectedPropertyValue(property, document.version), label),
        ));
        break;
      }
      case 'BDAY':
        fields.push(additionalField(
          property, occurrence, 'birthday', projectedLabel(document, property, 'Birthday'), raw,
        ));
        break;
      case 'ANNIVERSARY':
        fields.push(additionalField(
          property,
          occurrence,
          'anniversary',
          projectedLabel(document, property, 'Anniversary'),
          raw,
        ));
        break;
      case 'X-ABDATE':
        fields.push(additionalField(
          property,
          occurrence,
          'date',
          projectedLabel(document, property, 'Date'),
          raw,
        ));
        break;
      case 'ROLE':
        fields.push(additionalField(
          property, occurrence, 'role', projectedLabel(document, property, 'Role'), raw,
        ));
        break;
      case 'TITLE':
        fields.push(additionalField(
          property, occurrence, 'title', projectedLabel(document, property, 'Title'), raw,
        ));
        break;
      case 'NICKNAME':
        fields.push(additionalField(
          property,
          occurrence,
          'nickname',
          projectedLabel(document, property, 'Nickname'),
          raw,
        ));
        break;
      case 'GEO': {
        const value = parseGeoValue(property.rawValue);
        if (value) {
          fields.push(additionalField(
            property,
            occurrence,
            'geo',
            projectedLabel(document, property, 'Location'),
            value,
          ));
        }
        break;
      }
      case 'X-MAILFLOW-CUSTOM':
        fields.push(additionalField(
          property,
          occurrence,
          'custom-text',
          projectedLabel(document, property, 'Custom'),
          raw,
        ));
        break;
    }
  }

  assertAdditionalIds(
    fields,
    'vCard contains an invalid MailFlow Additional field ID',
    'vCard contains duplicate MailFlow Additional field IDs',
  );
  return fields;
}

function photoDataFromDocument(document) {
  let photoData = null;
  for (const property of propertiesNamed(document, 'PHOTO')) {
    const value = property.rawValue.trim();
    const kind = photoKind(property, document.version);
    if (kind === 'empty') continue;
    if (kind === 'url') {
      photoData = null;
      continue;
    }
    if (kind === 'data-uri') {
      photoData = supportedPhotoMimeType(embeddedPhotoMimeType(property, document.version))
        ? value
        : null;
      continue;
    }

    if (kind === 'base64') {
      decodeBase64Photo(value);
      const supported = supportedPhotoMimeType(
        embeddedPhotoMimeType(property, document.version),
      );
      photoData = supported
        ? 'data:' + supported.mime + ';base64,' + value.replace(/\s/g, '')
        : null;
      continue;
    }

    decodeBase64Photo(value);
    photoData = 'data:image/jpeg;base64,' + value.replace(/\s/g, '');
  }
  return photoData;
}

function emailFromProperty(property, primary) {
  const value = unescapeText(property.rawValue).trim().toLowerCase();
  if (!value) return null;
  const types = typesFor(property).map(type => type.toLowerCase());
  const type = types.find(entry => entry === 'work' || entry === 'home') || 'other';
  return { value, type, primary };
}

function v4EmailPreference(property) {
  const preferences = parameterValues(property, 'PREF')
    .map(value => String(value).trim())
    .filter(value => /^\d{1,2}$|^100$/.test(value))
    .map(Number)
    .filter(value => value >= 1 && value <= 100);
  return preferences.length ? Math.min(...preferences) : null;
}

function emailEntriesFromDocument(document) {
  const entries = [];
  document.properties.forEach((property, index) => {
    if (property.name !== 'EMAIL') return;
    const projected = emailFromProperty(property, false);
    if (!projected) return;
    entries.push({ index, property, projected });
  });
  if (entries.length === 0) return entries;

  let preferred;
  if (document.version === '4.0') {
    const preferences = entries.map(entry => v4EmailPreference(entry.property));
    const explicit = preferences.filter(value => value !== null);
    if (explicit.length) {
      const lowest = Math.min(...explicit);
      preferred = preferences.map(value => value === lowest);
    }
  } else {
    const explicit = entries.map(entry => (
      typesFor(entry.property).some(value => /^pref$/i.test(value))
    ));
    if (explicit.some(Boolean)) preferred = explicit;
  }
  preferred ||= entries.map(() => false);

  return entries.map((entry, index) => ({
    ...entry,
    projected: { ...entry.projected, primary: preferred[index] },
  }));
}

export function propertyUsesUriCodec(property, version) {
  const explicit = parameterValues(property, 'VALUE')[0];
  if (explicit !== undefined) return /^uri$/i.test(String(explicit).trim());
  return (version === '4.0' ? VCARD_4_URI_DEFAULTS : VCARD_3_URI_DEFAULTS)
    .has(property.name);
}

function projectedPropertyValue(property, version) {
  return propertyUsesUriCodec(property, version)
    ? String(property.rawValue)
    : unescapeText(property.rawValue);
}

function ownedPropertyRawValue(property, version, value) {
  return propertyUsesUriCodec(property, version) ? normalizedScalar(value) : escapeText(value);
}

function phoneFromProperty(property, version) {
  const value = projectedPropertyValue(property, version).trim();
  if (!value) return null;
  const types = typesFor(property)
    .map(type => type.toLowerCase())
    .map(type => type === 'cell' ? 'mobile' : type);
  const type = types.find(entry => (
    entry === 'mobile' || entry === 'work' || entry === 'home'
  )) || 'other';
  return { value, type };
}

export function contactFromVCardDocument(document) {
  const contact = {
    uid: null,
    displayName: null,
    firstName: null,
    lastName: null,
    emails: emailEntriesFromDocument(document).map(entry => entry.projected),
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
    additionalFields: additionalFieldsFromDocument(document),
  };

  for (const property of document.properties) {
    switch (property.name) {
      case 'UID':
        contact.uid = projectedPropertyValue(property, document.version).trim() || null;
        break;
      case 'FN':
        contact.displayName = unescapeText(property.rawValue).trim() || null;
        break;
      case 'N': {
        const parts = splitDelimited(property.rawValue, ';')
          .map(value => unescapeText(value).trim());
        contact.lastName = parts[0] || null;
        contact.firstName = parts[1] || null;
        break;
      }
      case 'EMAIL':
        break;
      case 'TEL': {
        const phone = phoneFromProperty(property, document.version);
        if (phone) contact.phones.push(phone);
        break;
      }
      case 'ORG':
        contact.organization = unescapeText(
          splitDelimited(property.rawValue, ';')[0] || '',
        ).trim() || null;
        break;
      case 'NOTE':
        contact.notes = unescapeText(property.rawValue).trim() || null;
        break;
    }
  }

  contact.photoData = photoDataFromDocument(document);
  return contact;
}

export const ADDITIONAL_PROPERTIES = new Set([
  'ADR',
  'URL',
  'IMPP',
  'BDAY',
  'ANNIVERSARY',
  'X-ABDATE',
  'ROLE',
  'TITLE',
  'NICKNAME',
  'GEO',
  'X-MAILFLOW-CUSTOM',
]);

export function contactValue(contact, camelName, snakeName) {
  if (Object.hasOwn(contact, camelName)) return contact[camelName];
  return contact[snakeName];
}

function lastPropertyIndex(properties, name) {
  for (let index = properties.length - 1; index >= 0; index--) {
    if (properties[index].name === name) return index;
  }
  return -1;
}

function structuredRawValue(property, replacements, minimumParts) {
  const parts = splitDelimited(property.rawValue, ';');
  while (parts.length < minimumParts) parts.push('');
  for (const [index, value] of replacements) parts[index] = escapeText(value || '');
  return parts.join(';');
}

function updatedTypeParameters(property, nextType, phone) {
  const ownedType = phone
    ? /^(?:cell|mobile|work|home|other)$/i
    : /^(?:work|home|other)$/i;
  const nextValue = escapeParam(nextType || 'other').toUpperCase();
  const params = structuredClone(property.params);
  let replaced = false;

  for (const parameter of params) {
    if (String(parameter.name).toUpperCase() !== 'TYPE') continue;
    parameter.values = parameter.values.flatMap(value => {
      if (!ownedType.test(value)) return [value];
      if (replaced) return [];
      replaced = true;
      return [nextValue];
    });
  }

  if (!replaced) {
    const parameter = params.find(entry => String(entry.name).toUpperCase() === 'TYPE');
    if (parameter) parameter.values.push(nextValue);
    else params.push({ name: 'TYPE', values: [nextValue] });
  }
  return params.filter(parameter => parameter.values.length > 0);
}

function emailPrimary(email, fallback = false) {
  if (Object.hasOwn(email, 'primary')) return normalizedBoolean(email.primary);
  if (Object.hasOwn(email, 'isPrimary')) return normalizedBoolean(email.isPrimary);
  if (Object.hasOwn(email, 'is_primary')) return normalizedBoolean(email.is_primary);
  return fallback;
}

function updatedEmailPreferenceParameters(property, version, primary) {
  const params = structuredClone(property.params);
  if (version === '4.0') {
    const updated = [];
    let written = false;
    for (const parameter of params) {
      if (String(parameter.name).toUpperCase() !== 'PREF') {
        updated.push(parameter);
      } else if (primary && !written) {
        updated.push({ ...parameter, name: 'PREF', values: ['1'] });
        written = true;
      }
    }
    if (primary && !written) updated.push({ name: 'PREF', values: ['1'] });
    return updated;
  }

  let written = false;
  const updated = params.map(parameter => {
    if (String(parameter.name).toUpperCase() !== 'TYPE') return parameter;
    const values = parameter.values.flatMap(value => {
      if (!/^pref$/i.test(value)) return [value];
      if (!primary || written) return [];
      written = true;
      return ['PREF'];
    });
    return { ...parameter, values };
  }).filter(parameter => parameter.values.length > 0);
  if (primary && !written) {
    const type = updated.find(parameter => String(parameter.name).toUpperCase() === 'TYPE');
    if (type) type.values.push('PREF');
    else updated.push({ name: 'TYPE', values: ['PREF'] });
  }
  return updated;
}

function additionalPropertyIndices(document) {
  const indices = new Map();

  for (const { index, property, occurrence } of propertiesWithOccurrences(document)) {
    if (ADDITIONAL_PROPERTIES.has(property.name)) {
      const id = additionalId(property, occurrence);
      if (indices.has(id)) {
        throw new Error('vCard contains duplicate MailFlow Additional field IDs');
      }
      indices.set(id, index);
    }
  }
  return indices;
}

function assertUniquePersistedAdditionalIds(document) {
  additionalPropertyIndices(document);
}

function sameAdditionalValue(first, second) {
  return JSON.stringify(canonicalJsonValue(first)) === JSON.stringify(canonicalJsonValue(second));
}

function retainedPhoto(property, version, hasPhoto, photoData) {
  if (property.name !== 'PHOTO') return false;
  if (!hasPhoto) return true;
  if (photoData) return false;
  return photoKind(property, version) === 'url';
}

function makeProperty(name, rawValue, params = [], group = null) {
  return { group, name, params, rawValue };
}

function canonicalOwnedPhotoData(photoData) {
  const value = String(photoData);
  const mimeType = /^data:/i.test(value) ? dataUriMimeType(value) : null;
  const supported = mimeType ? supportedPhotoMimeType(mimeType) : null;
  if (/^data:/i.test(value) && !supported) {
    throw new Error('vCard has unsupported PHOTO MIME type');
  }
  if (/^data:/i.test(value)) return canonicalSupportedPhotoDataUri(value);
  return 'data:image/jpeg;base64,' + decodeBase64Photo(value).toString('base64');
}

function photoProperty(version, photoData) {
  const value = canonicalOwnedPhotoData(photoData);
  const supported = supportedPhotoMimeType(dataUriMimeType(value));
  const inline = value.match(/^data:([^;,]+);base64,(.*)$/is);
  if (version === '4.0') {
    if (inline) {
      return makeProperty(
        'PHOTO',
        'data:' + supported.mime + ';base64,' + inline[2],
      );
    }
    if (/^data:/i.test(value)) {
      return makeProperty('PHOTO', value, [{ name: 'VALUE', values: ['URI'] }]);
    }
    return makeProperty('PHOTO', 'data:image/jpeg;base64,' + value);
  }

  if (inline) {
    return makeProperty('PHOTO', inline[2], [
      { name: 'ENCODING', values: ['b'] },
      { name: 'TYPE', values: [supported.type] },
    ]);
  }
  if (/^data:/i.test(value)) {
    return makeProperty('PHOTO', value, [{ name: 'VALUE', values: ['URI'] }]);
  }
  return makeProperty('PHOTO', value, [
    { name: 'ENCODING', values: ['b'] },
    { name: 'TYPE', values: ['JPEG'] },
  ]);
}

function rewrittenPhotoProperty(property, version, photoData) {
  const replacement = photoProperty(version, photoData);
  const retainedParams = retainedPhotoParameters(property.params);
  return {
    ...replacement,
    group: property.group,
    params: [...replacement.params, ...retainedParams],
  };
}

export function allocateItemGroup(usedGroups) {
  let index = 1;
  while (usedGroups.has(('item' + index).toLowerCase())) index++;
  const group = 'item' + index;
  usedGroups.add(group.toLowerCase());
  return group;
}

function additionalPropertyName(field) {
  const names = {
    'postal-address': 'ADR',
    url: 'URL',
    im: 'IMPP',
    birthday: 'BDAY',
    anniversary: 'ANNIVERSARY',
    date: 'X-ABDATE',
    role: 'ROLE',
    title: 'TITLE',
    nickname: 'NICKNAME',
    geo: 'GEO',
    'custom-text': 'X-MAILFLOW-CUSTOM',
  };
  return names[String(field.kind || '').toLowerCase()] || null;
}

function additionalRawValue(field, version, retainedProperty = null) {
  const kind = String(field.kind || '').toLowerCase();
  if (kind === 'postal-address') {
    const value = field.value || {};
    return ADR_COMPONENTS.map(component => escapeText(value[component] || '')).join(';');
  }
  if (kind === 'im') {
    const value = field.value || {};
    const rawValue = normalizedScalar(value.protocol || 'im').toLowerCase()
      + ':' + normalizedScalar(value.handle);
    return retainedProperty && !propertyUsesUriCodec(retainedProperty, version)
      ? escapeText(rawValue)
      : rawValue;
  }
  if (kind === 'url') {
    const rawValue = normalizedScalar(field.value);
    return retainedProperty && !propertyUsesUriCodec(retainedProperty, version)
      ? escapeText(rawValue)
      : rawValue;
  }
  if (kind === 'geo') {
    const value = field.value || {};
    if (version === '3.0') return value.latitude + ';' + value.longitude;
    return 'geo:' + value.latitude + ',' + value.longitude;
  }
  return escapeText(field.value || '');
}

export function additionalFieldLabel(field, kind) {
  const label = normalizedScalar(field?.label);
  if (label.trim()) return label;
  // A canonical/typed field maps to a real vCard property (BDAY, ADR, URL, …) and
  // only needs a label for optional X-ABLABEL grouping, so a blank label is valid.
  // A custom-text field carries its meaning solely in the label and still requires one.
  if (kind === 'custom-text') {
    throw new Error('MailFlow custom text field requires a label');
  }
  return '';
}

function additionalProperties(fields, usedGroups, version) {
  const properties = [];
  const labeledGroups = new Set();

  for (const field of fields) {
    const kind = String(field.kind || '').toLowerCase();
    const label = additionalFieldLabel(field, kind);
    const metadata = field.vcard || {};
    const name = additionalPropertyName(field);
    if (!name) continue;

    const compatibleMetadata = String(metadata.name || '').toUpperCase() === name;
    const group = kind === 'custom-text' || label ? allocateItemGroup(usedGroups) : null;
    const retainedParams = compatibleMetadata && Array.isArray(metadata.params)
      ? structuredClone(metadata.params)
      : [];
    const params = withAdditionalId(retainedParams, field.id);
    properties.push(makeProperty(name, additionalRawValue(field, version), params, group));

    const groupKey = String(group).toLowerCase();
    if (group && label && !labeledGroups.has(groupKey)) {
      properties.push(makeProperty('X-ABLABEL', escapeText(label), [], group));
      labeledGroups.add(groupKey);
    }
  }

  return properties;
}

export function overlayContactOnVCard(document, contact, { preserveDocumentUid = false } = {}) {
  const source = {
    version: document?.version || '3.0',
    properties: structuredClone(document?.properties || []),
  };
  const sourceContact = contactFromVCardDocument(source);
  const hasPhoto = Object.hasOwn(contact, 'photoData') || Object.hasOwn(contact, 'photo_data');
  const photoData = contactValue(contact, 'photoData', 'photo_data');
  const hasAdditional = Object.hasOwn(contact, 'additionalFields')
    || Object.hasOwn(contact, 'additional_fields');
  const additionalFields = contactValue(contact, 'additionalFields', 'additional_fields') || [];
  if (hasAdditional) {
    assertAdditionalIds(
      additionalFields,
      'MailFlow Additional field requires a stable ID',
      'MailFlow Additional field IDs must be unique',
    );
  }
  const uid = contactValue(contact, 'uid', 'uid');
  const displayName = contactValue(contact, 'displayName', 'display_name');
  const firstName = contactValue(contact, 'firstName', 'first_name');
  const lastName = contactValue(contact, 'lastName', 'last_name');
  const emails = contact.emails || [];
  const phones = contact.phones || [];
  const organization = contact.organization;
  const notes = contact.notes;
  const replacements = new Map();
  const appendedCore = [];
  const appendedAdditional = [];
  const groupsToClean = new Set();
  const labelUpdates = new Map();
  const usedGroups = new Set(
    source.properties.filter(property => property.group)
      .map(property => property.group.toLowerCase()),
  );

  const removeProperty = index => {
    replacements.set(index, []);
    const group = source.properties[index].group;
    if (group) groupsToClean.add(groupKey(group));
  };
  const replaceScalar = (name, sourceValue, nextValue, rawValue) => {
    const index = lastPropertyIndex(source.properties, name);
    const property = index >= 0 ? source.properties[index] : makeProperty(name, '');
    const nextRawValue = typeof rawValue === 'function' ? rawValue(property) : rawValue;
    if (index >= 0) {
      if (normalizedScalar(sourceValue) !== normalizedScalar(nextValue)) {
        replacements.set(index, [{ ...source.properties[index], rawValue: nextRawValue }]);
      }
    } else if (normalizedScalar(nextValue)) {
      appendedCore.push(makeProperty(name, nextRawValue));
    }
  };

  // UID is remote-owned identity. On an outgoing edit of an existing remote resource
  // (preserveDocumentUid) keep the retained document's UID so Mailflow never rewrites
  // it on the server; only mint from the contact when the document has no UID (create)
  // or when the caller wants the local key on the document (presented/local vCards).
  if (!(preserveDocumentUid && sourceContact.uid)) {
    replaceScalar('UID', sourceContact.uid, uid, property => (
      ownedPropertyRawValue(property, source.version, uid || '')
    ));
  }
  replaceScalar('FN', sourceContact.displayName, displayName, escapeText(displayName || ''));

  const nameIndex = lastPropertyIndex(source.properties, 'N');
  if (nameIndex >= 0) {
    if (normalizedScalar(sourceContact.lastName) !== normalizedScalar(lastName)
      || normalizedScalar(sourceContact.firstName) !== normalizedScalar(firstName)) {
      replacements.set(nameIndex, [{
        ...source.properties[nameIndex],
        rawValue: structuredRawValue(
          source.properties[nameIndex],
          [[0, lastName], [1, firstName]],
          5,
        ),
      }]);
    }
  } else if (firstName || lastName) {
    appendedCore.push(makeProperty(
      'N',
      escapeText(lastName || '') + ';' + escapeText(firstName || '') + ';;;',
    ));
  }

  const sourceEmails = emailEntriesFromDocument(source);
  const sourcePhones = [];
  source.properties.forEach((property, index) => {
    if (property.name === 'TEL') {
      const projected = phoneFromProperty(property, source.version);
      if (projected) sourcePhones.push({ index, projected });
    }
  });
  const normalizeEmailPreferences = emails.length !== sourceEmails.length
    || sourceEmails.some(({ projected }, index) => (
      !emails[index] || emailPrimary(emails[index], projected.primary) !== projected.primary
    ));

  sourceEmails.forEach(({ index, projected }, emailIndex) => {
    const next = emails[emailIndex];
    if (!next) {
      removeProperty(index);
      return;
    }
    const property = structuredClone(source.properties[index]);
    const nextValue = next.value ?? next.email ?? '';
    const nextType = String(next.type || 'other').toLowerCase();
    const nextPrimary = emailPrimary(next, projected.primary);
    let changed = false;
    if (String(nextValue).trim().toLowerCase() !== projected.value) {
      property.rawValue = escapeText(nextValue);
      changed = true;
    }
    if (nextType !== projected.type) {
      property.params = updatedTypeParameters(property, nextType, false);
      changed = true;
    }
    if (normalizeEmailPreferences) {
      property.params = updatedEmailPreferenceParameters(property, source.version, nextPrimary);
      changed = true;
    }
    if (changed) replacements.set(index, [property]);
  });
  for (const email of emails.slice(sourceEmails.length)) {
    const property = makeProperty(
      'EMAIL',
      escapeText(email.value ?? email.email ?? ''),
      [{ name: 'TYPE', values: [escapeParam(email.type || 'other').toUpperCase()] }],
    );
    property.params = updatedEmailPreferenceParameters(
      property,
      source.version,
      emailPrimary(email),
    );
    appendedCore.push(property);
  }

  sourcePhones.forEach(({ index, projected }, phoneIndex) => {
    const next = phones[phoneIndex];
    if (!next) {
      removeProperty(index);
      return;
    }
    const property = structuredClone(source.properties[index]);
    const nextValue = next.value ?? next.number ?? '';
    const nextType = normalizedType(next.type || 'other');
    let changed = false;
    if (String(nextValue).trim() !== projected.value) {
      property.rawValue = ownedPropertyRawValue(property, source.version, nextValue);
      changed = true;
    }
    if (nextType !== projected.type) {
      property.params = updatedTypeParameters(property, nextType, true);
      changed = true;
    }
    if (changed) replacements.set(index, [property]);
  });
  for (const phone of phones.slice(sourcePhones.length)) {
    const property = makeProperty(
      'TEL',
      '',
      [{ name: 'TYPE', values: [escapeParam(phone.type || 'voice').toUpperCase()] }],
    );
    property.rawValue = ownedPropertyRawValue(
      property,
      source.version,
      phone.value ?? phone.number ?? '',
    );
    appendedCore.push(property);
  }

  const organizationIndex = lastPropertyIndex(source.properties, 'ORG');
  if (organizationIndex >= 0) {
    if (normalizedScalar(sourceContact.organization) !== normalizedScalar(organization)) {
      replacements.set(organizationIndex, [{
        ...source.properties[organizationIndex],
        rawValue: structuredRawValue(source.properties[organizationIndex], [[0, organization]], 1),
      }]);
    }
  } else if (organization) {
    appendedCore.push(makeProperty('ORG', escapeText(organization)));
  }
  replaceScalar('NOTE', sourceContact.notes, notes, escapeText(notes || ''));

  if (hasAdditional) {
    const propertyIndices = additionalPropertyIndices(source);
    const sourceFields = new Map(sourceContact.additionalFields.map(field => [field.id, field]));
    const targetById = new Map(additionalFields.map(field => [contactAdditionalId(field), field]));
    const sourceIndices = sourceContact.additionalFields
      .map(field => propertyIndices.get(field.id))
      .sort((first, second) => first - second);

    const sourceOrderByIdentity = new Map();
    for (const field of sourceContact.additionalFields) {
      const propertyIndex = propertyIndices.get(field.id);
      if (hasPersistedAdditionalId(source.properties[propertyIndex])) continue;
      const key = propertyIdentityKey(field.vcard);
      const ids = sourceOrderByIdentity.get(key) || [];
      ids.push(field.id);
      sourceOrderByIdentity.set(key, ids);
    }
    for (const ids of sourceOrderByIdentity.values()) {
      if (ids.length < 2) continue;
      const targetIds = new Set(additionalFields.map(contactAdditionalId));
      let deletedEarlier = false;
      for (const id of ids) {
        if (!targetIds.has(id)) {
          deletedEarlier = true;
        } else if (deletedEarlier) {
          throw new Error(
            'MailFlow Additional fields cannot delete an earlier ambiguous retained property',
          );
        }
      }
      const positions = new Map(ids.map((id, index) => [id, index]));
      const targetOrder = additionalFields
        .map(field => positions.get(contactAdditionalId(field)))
        .filter(position => position !== undefined);
      if (targetOrder.some((position, index) => index > 0 && position < targetOrder[index - 1])) {
        throw new Error(
          'MailFlow Additional fields cannot reorder ambiguous retained properties',
        );
      }
    }

    const canUpdateSharedLabel = (sourceField, nextLabel) => {
      const key = groupKey(sourceField.vcard?.group);
      if (!key) return false;
      const groupedProperties = source.properties.filter(property => (
        groupKey(property.group) === key && property.name !== 'X-ABLABEL'
      ));
      const groupedFields = sourceContact.additionalFields.filter(field => (
        groupKey(field.vcard?.group) === key
      ));
      if (groupedProperties.length !== groupedFields.length) return false;
      return groupedFields.every(field => {
        const target = targetById.get(String(field.id || ''));
        return target
          && additionalPropertyName(target) === field.vcard.name
          && normalizedScalar(target.label) === nextLabel;
      });
    };

    const derivedIdsToPersist = new Set();
    const projectedSourceIndices = new Set(sourceIndices);
    const targetRowIndices = new Map();
    for (const targetField of additionalFields) {
      if (additionalPropertyName(targetField)) {
        targetRowIndices.set(contactAdditionalId(targetField), targetRowIndices.size);
      }
    }
    const sourceFieldsByIdentity = new Map();
    for (const sourceField of sourceContact.additionalFields) {
      const key = propertyIdentityKey(sourceField.vcard);
      const fields = sourceFieldsByIdentity.get(key) || [];
      fields.push(sourceField);
      sourceFieldsByIdentity.set(key, fields);
    }
    for (const [identityKey, sourceIdentityFields] of sourceFieldsByIdentity) {
      const retainedTargetFields = additionalFields.flatMap(field => {
        const sourceField = sourceFields.get(contactAdditionalId(field));
        if (!sourceField) return [];
        const sourceKey = propertyIdentityKey(sourceField.vcard);
        if (sourceKey !== identityKey || additionalPropertyName(field) !== sourceField.vcard.name) {
          return [];
        }
        const nextLabel = additionalFieldLabel(field, String(field.kind || '').toLowerCase());
        if (normalizedScalar(sourceField.label) !== nextLabel
          && !canUpdateSharedLabel(sourceField, nextLabel)) {
          return [];
        }
        return [{ sourceField, targetRowIndex: targetRowIndices.get(contactAdditionalId(field)) }];
      });

      for (const sourceField of sourceIdentityFields) {
        const propertyIndex = propertyIndices.get(sourceField.id);
        const retainedProperty = source.properties[propertyIndex];
        if (hasPersistedAdditionalId(retainedProperty)) continue;
        const targetOccurrenceIndex = retainedTargetFields.findIndex(
          retained => retained.sourceField.id === sourceField.id,
        );
        if (targetOccurrenceIndex < 0) continue;
        const targetSlot = sourceIndices[
          retainedTargetFields[targetOccurrenceIndex].targetRowIndex
        ] ?? Infinity;
        const opaquePredecessors = source.properties.filter((property, index) => (
          index < targetSlot
          && !projectedSourceIndices.has(index)
          && propertyIdentityKey(property) === identityKey
        )).length;
        const targetOccurrence = targetOccurrenceIndex + opaquePredecessors;
        if (stableAdditionalId(retainedProperty, targetOccurrence) !== sourceField.id) {
          derivedIdsToPersist.add(sourceField.id);
        }
      }
    }

    const targetRows = additionalFields.flatMap(field => {
      const kind = String(field.kind || '').toLowerCase();
      const nextLabel = additionalFieldLabel(field, kind);
      const id = contactAdditionalId(field);
      const sourceField = sourceFields.get(id);
      const propertyIndex = sourceField ? propertyIndices.get(id) : null;
      const retainedProperty = propertyIndex == null ? null : source.properties[propertyIndex];
      const name = additionalPropertyName(field);
      if (!name) return [];
      if (!sourceField || retainedProperty.name !== name) {
        return [additionalProperties([field], usedGroups, source.version)];
      }

      const property = structuredClone(retainedProperty);
      if (derivedIdsToPersist.has(id)) {
        property.params = withAdditionalId(property.params, id);
      }
      if (!sameAdditionalValue(field.value, sourceField.value)) {
        property.rawValue = additionalRawValue(field, source.version, retainedProperty);
      }
      const sourceLabel = normalizedScalar(sourceField.label);
      if (sourceLabel === nextLabel) return [[property]];

      if (canUpdateSharedLabel(sourceField, nextLabel)) {
        const key = groupKey(property.group);
        if (!labelUpdates.has(key)) {
          labelUpdates.set(key, {
            group: property.group,
            rawValue: nextLabel ? escapeText(nextLabel) : null,
            remove: !nextLabel,
          });
        }
        return [[property]];
      }

      // A cleared label drops the custom X-ABLABEL: keep the property but leave it
      // ungrouped so it projects back to its default (type/kind) label.
      if (!nextLabel) {
        property.group = null;
        return [[property]];
      }

      property.group = allocateItemGroup(usedGroups);
      property.params = withAdditionalId(property.params, id);
      return [[
        property,
        makeProperty('X-ABLABEL', escapeText(nextLabel), [], property.group),
      ]];
    });

    sourceIndices.forEach((propertyIndex, index) => {
      const group = source.properties[propertyIndex].group;
      if (group) groupsToClean.add(groupKey(group));
      replacements.set(propertyIndex, targetRows[index] || []);
    });
    for (const row of targetRows.slice(sourceIndices.length)) {
      appendedAdditional.push(...row);
    }
  }

  let appendedPhoto = [];
  if (hasPhoto && normalizedPhoto(photoData) !== normalizedPhoto(sourceContact.photoData)) {
    let rewrittenPhotoIndex = -1;
    if (photoData && !/^https?:\/\//i.test(photoData) && sourceContact.photoData) {
      const sourcePhotoIdentity = normalizedPhoto(sourceContact.photoData);
      for (let index = source.properties.length - 1; index >= 0; index--) {
        const property = source.properties[index];
        if (property.name === 'PHOTO'
          && semanticPhotoIdentity(property, source.version) === sourcePhotoIdentity) {
          rewrittenPhotoIndex = index;
          replacements.set(index, [rewrittenPhotoProperty(property, source.version, photoData)]);
          break;
        }
      }
    }
    source.properties.forEach((property, index) => {
      if (index !== rewrittenPhotoIndex
        && property.name === 'PHOTO'
        && !retainedPhoto(property, source.version, hasPhoto, photoData)) {
        removeProperty(index);
      }
    });
    if (rewrittenPhotoIndex < 0 && photoData && !/^https?:\/\//i.test(photoData)) {
      appendedPhoto = [photoProperty(source.version, photoData)];
    }
  }

  let properties = [];
  source.properties.forEach((property, index) => {
    if (SERVER_OWNED_PROPERTIES.has(property.name)) return;
    properties.push(...(replacements.get(index) || [property]));
  });
  properties.push(...appendedCore, ...appendedPhoto, ...appendedAdditional);

  const updatedLabels = new Set();
  properties = properties.flatMap(property => {
    if (property.name !== 'X-ABLABEL') return [property];
    const key = groupKey(property.group);
    const update = labelUpdates.get(key);
    if (!update || updatedLabels.has(key)) return [property];
    updatedLabels.add(key);
    if (update.remove) return [];
    return [{ ...property, group: update.group, rawValue: update.rawValue }];
  });
  for (const [key, update] of labelUpdates) {
    if (!updatedLabels.has(key) && !update.remove) {
      properties.push(makeProperty('X-ABLABEL', update.rawValue, [], update.group));
    }
  }
  for (const key of groupsToClean) {
    const hasGroupedProperty = properties.some(property => (
      property.name !== 'X-ABLABEL' && groupKey(property.group) === key
    ));
    if (!hasGroupedProperty) {
      properties = properties.filter(property => !(
        property.name === 'X-ABLABEL' && groupKey(property.group) === key
      ));
    }
  }

  return {
    version: source.version,
    properties,
  };
}

// Replace a document's UID property with `uidProperty` (dropping duplicate UID lines),
// preserving the given UID's exact encoding. A plain array transform that does not throw.
export function withDocumentUid(document, uidProperty) {
  if (!uidProperty) return document;
  let replaced = false;
  const properties = document.properties.flatMap(property => {
    if (property.name !== 'UID') return [property];
    if (replaced) return [];
    replaced = true;
    return [structuredClone(uidProperty)];
  });
  if (!replaced) properties.unshift(structuredClone(uidProperty));
  return { ...document, properties };
}

// A push-destined snapshot must NEVER emit a local UID upstream. When the overlay
// throws (e.g. assertAdditionalIds on malformed Additional-field IDs), re-key the stored
// vCard to the retained document's remote UID via transforms that cannot throw; if that is
// impossible (no retained UID, or the stored vCard is unparseable), fail CLOSED by
// re-throwing so the conflict/recovery machinery surfaces the error rather than pushing a
// wrong UID. Never falls back to the raw local-UID document.
export function pushSafeSnapshot(rawVcard, retainedDocument, cause) {
  const retainedUidProperty = retainedDocument?.properties?.find(property => property.name === 'UID');
  if (retainedUidProperty && typeof rawVcard === 'string') {
    try {
      const rekeyed = serializeVCardDocument(withDocumentUid(parseVCardDocument(rawVcard), retainedUidProperty));
      console.warn('[carddav] presented overlay failed; pushed re-keyed fallback snapshot');
      return rekeyed;
    } catch {
      // fall through to fail closed
    }
  }
  throw cause;
}

// preserveDocumentUid: false (default) keeps the LOCAL UID that keys the resource URL —
// what the CardDAV server serves; an overlay failure falls back to the stored vCard so a
// read never fails. true keeps the retained REMOTE UID — for a conflict snapshot that
// keep-mailflow pushes verbatim, where the remote resource's UID must never be rewritten;
// an overlay failure re-keys or fails closed via pushSafeSnapshot, never
// emitting the local-UID document. Do not conflate the two usages.
//
// The document MailFlow's own CardDAV server serves to native clients. For a mapped
// contact it overlays the local modeled columns onto the retained lossless remote
// vCard so unmodeled server properties (CATEGORIES, KEY, TZ, X-*) are visible to and
// round-trip through the client. Unmapped/local contacts serve their stored vCard, and
// any overlay failure falls back to it so a read never fails. `contact` is a raw contacts
// row (snake_case columns + parsed jsonb emails/phones); overlayContactOnVCard reads both
// column casings.
export function presentedVCard(contact, { preserveDocumentUid = false } = {}) {
  if (!contact.mapping_vcard) return contact.vcard;
  let retained;
  try {
    retained = parseVCardDocument(contact.mapping_vcard);
    return serializeVCardDocument(overlayContactOnVCard(retained, contact, { preserveDocumentUid }));
  } catch (error) {
    if (!preserveDocumentUid) return contact.vcard;
    return pushSafeSnapshot(contact.vcard, retained, error);
  }
}

// The strong ETag MailFlow's CardDAV server serves for a contact, derived from the
// PRESENTED representation rather than contacts.etag. This advances whenever the
// served bytes change — including a remote-only edit to unmodeled properties that leaves
// the modeled columns (and contacts.etag) untouched — so a stale If-Match is rejected and
// getctag pollers that re-fetch see fresh bytes under a fresh ETag.
export function presentedEtag(contact) {
  return createHash('md5').update(presentedVCard(contact)).digest('hex');
}

export function semanticPhotoIdentity(property, version) {
  const supported = supportedPhotoMimeType(embeddedPhotoMimeType(property, version));
  if (!supported) return null;
  const kind = photoKind(property, version);
  if (kind === 'data-uri') return canonicalSupportedPhotoDataUri(property.rawValue);
  if (kind === 'base64' || kind === 'legacy-base64') {
    const bytes = decodeBase64Photo(property.rawValue);
    return 'data:' + supported.mime + ';base64,' + bytes.toString('base64');
  }
  return null;
}

export function normalizedScalar(value) {
  if (value == null || value === '') return '';
  return String(value).replace(/\r\n|\r/g, '\n');
}

export function normalizedType(value) {
  const type = normalizedScalar(value).trim().toLowerCase();
  return type === 'cell' ? 'mobile' : type;
}

export function normalizedBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

export function normalizedPhoto(value) {
  const photo = normalizedScalar(value);
  const canonical = canonicalSupportedPhotoDataUri(photo);
  if (canonical || !photo || /^data:|^https?:\/\//i.test(photo)) return canonical || photo;
  return 'data:image/jpeg;base64,' + decodeBase64Photo(photo).toString('base64');
}

export function canonicalJsonValue(value, key = '') {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(entry => canonicalJsonValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(name => [name, canonicalJsonValue(value[name], name)]),
    );
  }
  if (typeof value === 'string') {
    const normalized = normalizedScalar(value);
    return key === 'kind' || key === 'type' ? normalized.toLowerCase() : normalized;
  }
  return value;
}
