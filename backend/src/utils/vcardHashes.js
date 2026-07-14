import { createHash } from 'node:crypto';

import {
  ADR_COMPONENTS,
  SERVER_OWNED_PROPERTIES,
  VCARD_3_URI_DEFAULTS,
  VCARD_4_URI_DEFAULTS,
  decodeBase64Photo,
  parameterValues,
  photoKind,
  retainedPhotoParameters,
} from './vcardDocument.js';
import {
  additionalFieldLabel,
  assertAdditionalIds,
  canonicalJsonValue,
  contactValue,
  groupKey,
  normalizedBoolean,
  normalizedPhoto,
  normalizedScalar,
  normalizedType,
  propertyUsesUriCodec,
  semanticPhotoIdentity,
} from './vcardProjection.js';

export function localVCardEtag(vcard) {
  return createHash('md5').update(vcard).digest('hex');
}

function normalizeSemanticRawValue(property, version) {
  let value = property.rawValue.replace(/\r\n|\r/g, '\n');
  if (!propertyUsesUriCodec(property, version)) value = value.replace(/\\N/g, '\\n');
  if (property.name === 'PHOTO') {
    const supportedIdentity = semanticPhotoIdentity(property, version);
    if (supportedIdentity) return supportedIdentity;
    const dataUri = value.match(/^data:([^,]*),(.*)$/is);
    if (dataUri) {
      const metadata = dataUri[1].split(';');
      const mediaType = metadata.shift().trim().toLowerCase();
      const parameters = [];
      let base64 = false;
      for (const entry of metadata) {
        const trimmed = entry.trim();
        if (/^base64$/i.test(trimmed)) {
          base64 = true;
          continue;
        }
        const equals = trimmed.indexOf('=');
        parameters.push(equals < 0
          ? trimmed.toLowerCase()
          : trimmed.slice(0, equals).toLowerCase() + trimmed.slice(equals));
      }
      if (base64) {
        const prefix = [mediaType, ...parameters, 'base64'].filter(Boolean).join(';');
        return 'data:' + prefix + ',' + decodeBase64Photo(dataUri[2]).toString('base64');
      }
    }

    const kind = photoKind(property, version);
    if (kind === 'base64' || kind === 'legacy-base64') {
      value = decodeBase64Photo(value).toString('base64');
    }
  }
  return value;
}

function canonicalSemanticParameters(params) {
  const byName = new Map();

  for (const parameter of params) {
    const name = parameter.name.toUpperCase();
    const values = byName.get(name) || [];
    values.push(...parameter.values.map(value => (
      /^(?:TYPE|ENCODING|VALUE|MEDIATYPE)$/.test(name)
        ? value.toLowerCase()
        : value
    )));
    byName.set(name, values);
  }

  return [...byName]
    .sort(([first], [second]) => {
      if (first < second) return -1;
      if (first > second) return 1;
      return 0;
    })
    .map(([name, values]) => ({
      name,
      values: name === 'TYPE' ? [...new Set(values)].sort() : values,
    }));
}

function semanticParametersFor(property, version, photoIdentity) {
  if (photoIdentity) {
    return retainedPhotoParameters(property.params, {
      retainImageTypeValues: version === '4.0',
    });
  }

  const valueTypes = parameterValues(property, 'VALUE');
  const uriDefaults = version === '4.0' ? VCARD_4_URI_DEFAULTS : VCARD_3_URI_DEFAULTS;
  if (valueTypes.length === 1
    && /^uri$/i.test(String(valueTypes[0]).trim())
    && uriDefaults.has(property.name)) {
    return property.params.filter(parameter => String(parameter.name).toUpperCase() !== 'VALUE');
  }
  return property.params;
}

export function semanticVCardHash(document) {
  const groups = new Map();
  let nextGroup = 1;
  const canonical = {
    version: document.version,
    properties: document.properties
      .filter(property => !SERVER_OWNED_PROPERTIES.has(property.name))
      .map(property => {
        const key = groupKey(property.group);
        const photoIdentity = property.name === 'PHOTO'
          ? semanticPhotoIdentity(property, document.version)
          : null;
        const semanticParams = semanticParametersFor(
          property,
          document.version,
          photoIdentity,
        );
        if (key && !groups.has(key)) groups.set(key, `group-${nextGroup++}`);
        return {
          group: key ? groups.get(key) : '',
          name: property.name.toUpperCase(),
          params: canonicalSemanticParameters(semanticParams),
          rawValue: photoIdentity || normalizeSemanticRawValue(property, document.version),
        };
      }),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function canonicalAdditionalField(field) {
  const source = field && typeof field === 'object' ? field : {};
  const kind = normalizedScalar(source.kind).toLowerCase();
  const sourceValue = source.value && typeof source.value === 'object'
    && !Array.isArray(source.value) ? source.value : {};
  let value = source.value;
  if (kind === 'postal-address') {
    value = Object.fromEntries(ADR_COMPONENTS.map(component => [component, sourceValue[component]]));
  } else if (kind === 'im') {
    value = {
      protocol: normalizedScalar(sourceValue.protocol || 'im').toLowerCase(),
      handle: sourceValue.handle,
    };
  }
  return {
    id: normalizedScalar(source.id),
    kind,
    label: additionalFieldLabel(source, kind),
    value: canonicalJsonValue(value),
  };
}

export function localContactHash(contact) {
  const emails = (contact.emails || []).map(email => ({
    value: normalizedScalar(email.value ?? email.email).trim().toLowerCase(),
    type: normalizedType(email.type || 'other'),
    primary: normalizedBoolean(email.primary ?? email.isPrimary ?? email.is_primary),
  }));
  const phones = (contact.phones || []).map(phone => ({
    value: normalizedScalar(phone.value ?? phone.number).replace(/\s/g, ''),
    type: normalizedType(phone.type || 'other'),
  }));
  const additionalFields = contactValue(contact, 'additionalFields', 'additional_fields') || [];
  assertAdditionalIds(
    additionalFields,
    'MailFlow Additional field requires a stable ID',
    'MailFlow Additional field IDs must be unique',
  );
  const canonical = {
    uid: normalizedScalar(contact.uid),
    displayName: normalizedScalar(contactValue(contact, 'displayName', 'display_name')),
    firstName: normalizedScalar(contactValue(contact, 'firstName', 'first_name')),
    lastName: normalizedScalar(contactValue(contact, 'lastName', 'last_name')),
    emails,
    phones,
    organization: normalizedScalar(contact.organization),
    notes: normalizedScalar(contact.notes),
    photoData: normalizedPhoto(contactValue(contact, 'photoData', 'photo_data')),
    additionalFields: additionalFields.map(canonicalAdditionalField),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
