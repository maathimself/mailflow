const MAX_VCARD_BYTES = 1024 * 1024;
const MAX_PROPERTIES = 2000;
const MAX_PARAMETERS = 64;
const MAX_CONTENT_LINE_BYTES = 64 * 1024;
const MAX_PHOTO_BYTES = 512 * 1024;
const VCARD_TOKEN = /^[A-Za-z0-9-]+$/;
export const VCARD_3_URI_DEFAULTS = new Set(['URL', 'IMPP']);
export const VCARD_4_URI_DEFAULTS = new Set([
  'SOURCE',
  'PHOTO',
  'TEL',
  'IMPP',
  'GEO',
  'LOGO',
  'MEMBER',
  'RELATED',
  'SOUND',
  'UID',
  'URL',
  'KEY',
  'FBURL',
  'CALADRURI',
  'CALURI',
]);
const SUPPORTED_PHOTO_MIME_TYPES = new Map([
  ['image/jpeg', { mime: 'image/jpeg', type: 'JPEG' }],
  ['image/jpg', { mime: 'image/jpeg', type: 'JPEG' }],
  ['image/png', { mime: 'image/png', type: 'PNG' }],
  ['image/gif', { mime: 'image/gif', type: 'GIF' }],
  ['image/webp', { mime: 'image/webp', type: 'WEBP' }],
]);
export const PHOTO_IMAGE_TYPE_TOKENS = new Set(
  [...SUPPORTED_PHOTO_MIME_TYPES.keys()].map(mime => mime.slice('image/'.length).toUpperCase()),
);
export const ADR_COMPONENTS = [
  'poBox',
  'extendedAddress',
  'street',
  'locality',
  'region',
  'postalCode',
  'country',
];

export const SERVER_OWNED_PROPERTIES = new Set([
  'PRODID',
  'REV',
  'SOURCE',
  'CREATED',
  'LAST-MODIFIED',
]);

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function percentDecodedByteLength(value) {
  let bytes = 0;
  let literalStart = 0;

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '%') continue;
    bytes += byteLength(value.slice(literalStart, index));
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      throw new Error('invalid percent encoding');
    }
    bytes++;
    index += 2;
    literalStart = index + 1;
  }

  return bytes + byteLength(value.slice(literalStart));
}

function decodePercentEncodedPhoto(value) {
  const decodedLength = percentDecodedByteLength(value);
  if (decodedLength > MAX_PHOTO_BYTES) {
    throw new Error('vCard exceeds the 512 KiB photo limit');
  }

  const decoded = Buffer.allocUnsafe(decodedLength);
  let offset = 0;
  let literalStart = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '%') continue;
    if (index > literalStart) {
      offset += decoded.write(value.slice(literalStart, index), offset, 'utf8');
    }
    decoded[offset++] = Number.parseInt(value.slice(index + 1, index + 3), 16);
    index += 2;
    literalStart = index + 1;
  }
  if (literalStart < value.length) decoded.write(value.slice(literalStart), offset, 'utf8');
  return decoded;
}

function splitPhysicalLines(text) {
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (byteLength(line) > MAX_CONTENT_LINE_BYTES) {
      throw new Error('vCard exceeds the 64 KiB physical line limit');
    }
  }
  return lines;
}

function unfoldLines(lines) {
  const unfolded = [];
  let current = null;

  for (const line of lines) {
    if (/^[ \t]/.test(line) && current !== null) {
      current += line.slice(1);
      continue;
    }
    if (current !== null) unfolded.push(current);
    current = line;
  }
  if (current !== null) unfolded.push(current);

  return unfolded;
}

function delimiterIndex(value, delimiter, backslashEscapes = true) {
  let escaped = false;
  let quoted = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (backslashEscapes && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === delimiter && !quoted) return index;
  }

  return -1;
}

export function splitDelimited(value, delimiter, backslashEscapes = true) {
  const parts = [];
  let rest = value;

  while (true) {
    const index = delimiterIndex(rest, delimiter, backslashEscapes);
    if (index < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }

  return parts;
}

function decodeParameterValue(value, version) {
  if (version !== '4.0') return value;
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '^' || index + 1 >= value.length) {
      result += character;
      continue;
    }

    const next = value[++index];
    if (next === '^') result += '^';
    else if (next === 'n' || next === 'N') result += '\n';
    else if (next === "'") result += '"';
    else result += '^' + next;
  }
  return result;
}

function quotedParameterValue(value, quote = '"') {
  let start = 0;
  let end = value.length;
  while (start < end && /[ \t]/.test(value[start])) start++;
  while (end > start && /[ \t]/.test(value[end - 1])) end--;
  if (value[start] !== quote || value[end - 1] !== quote) return null;
  return value.slice(start + 1, end - 1);
}

function parseParameterValues(name, encodedValue, version) {
  if (name === 'TYPE' && version === '3.0') {
    const legacy = quotedParameterValue(encodedValue, "'");
    if (legacy !== null) return legacy.split(',');
  }

  const entries = splitDelimited(encodedValue, ',', false);
  if (entries.length === 0) return [''];
  if (entries.length === 1) {
    const quoted = quotedParameterValue(entries[0]);
    if (quoted !== null) {
      const decoded = decodeParameterValue(quoted, version);
      return name === 'TYPE' ? decoded.split(',') : [decoded];
    }
  }
  return entries.map(entry => {
    const quoted = quotedParameterValue(entry);
    return decodeParameterValue(quoted === null ? entry : quoted, version);
  });
}

function hasForbiddenParameterControl(value, version) {
  return [...String(value)].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint === 127 || (
      codePoint < 32
      && character !== '\t'
      && (version !== '4.0' || (character !== '\r' && character !== '\n'))
    );
  });
}

function hasInvalidParameterValue(value, version) {
  return (version !== '4.0' && String(value).includes('"'))
    || hasForbiddenParameterControl(value, version);
}

function parseParameters(parts, version) {
  if (parts.length > MAX_PARAMETERS) {
    throw new Error('vCard property exceeds the 64 parameters limit');
  }

  return parts.map(part => {
    const equals = delimiterIndex(part, '=', false);
    if (equals < 0) {
      const values = [decodeParameterValue(part, version)];
      if (values.some(value => hasInvalidParameterValue(value, version))) {
        throw new Error('vCard parameter value contains an invalid character');
      }
      return { name: 'TYPE', values };
    }

    const name = part.slice(0, equals).toUpperCase();
    if (!VCARD_TOKEN.test(name)) {
      throw new Error('vCard contains an invalid parameter name');
    }
    const encodedValue = part.slice(equals + 1);
    const values = parseParameterValues(name, encodedValue, version);
    if (values.some(value => hasInvalidParameterValue(value, version))) {
      throw new Error('vCard parameter value contains an invalid character');
    }
    return {
      name,
      values,
    };
  });
}

function parseContentLine(line, version) {
  const colon = delimiterIndex(line, ':', false);
  if (colon < 0) throw new Error('vCard contains an invalid content line');

  const header = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);
  const parts = splitDelimited(header, ';', false);
  let name = parts.shift();
  let group = null;
  const dot = name.indexOf('.');
  if (dot >= 0) {
    group = name.slice(0, dot);
    name = name.slice(dot + 1);
  }
  if (group !== null && !VCARD_TOKEN.test(group)) {
    throw new Error('vCard contains an invalid property group');
  }
  name = name.toUpperCase();
  if (!VCARD_TOKEN.test(name)) throw new Error('vCard contains an invalid property name');

  return {
    group,
    name,
    params: parseParameters(parts, version),
    rawValue,
  };
}

export function parameterValues(property, name) {
  return property.params
    .filter(parameter => parameter.name === name)
    .flatMap(parameter => parameter.values);
}

export function decodeBase64Photo(value) {
  let dataLength = 0;
  let paddingLength = 0;
  let paddingStarted = false;
  for (const character of value) {
    if (/\s/.test(character)) continue;
    if (/^[A-Za-z0-9+/]$/.test(character) && !paddingStarted) {
      dataLength++;
      continue;
    }
    if (character === '=') {
      paddingStarted = true;
      paddingLength++;
      continue;
    }
    throw new Error('vCard PHOTO has invalid base64 data');
  }

  const remainder = dataLength % 4;
  const validPadding = paddingLength === 0 || (
    (dataLength + paddingLength) % 4 === 0
    && ((paddingLength === 1 && remainder === 3)
      || (paddingLength === 2 && remainder === 2))
  );
  if (paddingLength > 2
    || remainder === 1
    || !validPadding) {
    throw new Error('vCard PHOTO has invalid base64 data');
  }
  if (Math.floor(dataLength * 6 / 8) > MAX_PHOTO_BYTES) {
    throw new Error('vCard exceeds the 512 KiB photo limit');
  }

  const compact = value.replace(/\s/g, '');
  const withoutPadding = compact.slice(0, dataLength);
  const decoded = Buffer.from(withoutPadding, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== withoutPadding) {
    throw new Error('vCard PHOTO has invalid base64 data');
  }
  if (decoded.length > MAX_PHOTO_BYTES) {
    throw new Error('vCard exceeds the 512 KiB photo limit');
  }
  return decoded;
}

export function photoKind(property, version) {
  const value = property.rawValue.trim();
  if (!value) return 'empty';
  const valueType = parameterValues(property, 'VALUE')[0];
  if (valueType !== undefined && /^uri$/i.test(valueType)) return 'url';
  const encodings = parameterValues(property, 'ENCODING');
  if (encodings.some(encoding => /^(?:b|base64)$/i.test(encoding))) return 'base64';
  if (valueType !== undefined || encodings.length) return 'legacy-base64';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^data:/i.test(value)) return 'data-uri';
  if (version === '4.0') return 'url';
  return 'legacy-base64';
}

export function dataUriMimeType(value) {
  const dataUri = String(value).match(/^data:([^,]*),/is);
  return dataUri ? dataUri[1].split(';')[0].trim().toLowerCase() : null;
}

export function supportedPhotoMimeType(value) {
  return SUPPORTED_PHOTO_MIME_TYPES.get(String(value || '').trim().toLowerCase()) || null;
}

export function retainedPhotoParameters(params, { retainImageTypeValues = false } = {}) {
  return params.flatMap(parameter => {
    const name = String(parameter.name).toUpperCase();
    if (/^(?:ENCODING|MEDIATYPE|VALUE)$/.test(name)) return [];
    if (name !== 'TYPE' || retainImageTypeValues) return [structuredClone(parameter)];
    const values = parameter.values.filter(value => (
      !PHOTO_IMAGE_TYPE_TOKENS.has(String(value).toUpperCase())
    ));
    return values.length ? [{ ...structuredClone(parameter), values }] : [];
  });
}

export function canonicalSupportedPhotoDataUri(value) {
  const dataUri = String(value).match(/^data:([^,]*),(.*)$/is);
  if (!dataUri) return null;
  const supported = supportedPhotoMimeType(dataUri[1].split(';')[0]);
  if (!supported) return null;
  const bytes = /(?:^|;)base64(?:;|$)/i.test(dataUri[1])
    ? decodeBase64Photo(dataUri[2])
    : decodePercentEncodedPhoto(dataUri[2]);
  return 'data:' + supported.mime + ';base64,' + bytes.toString('base64');
}

export function embeddedPhotoMimeType(property, version) {
  const kind = photoKind(property, version);
  if (kind === 'data-uri') return dataUriMimeType(property.rawValue);
  if (kind === 'legacy-base64') return 'image/jpeg';
  if (kind !== 'base64') return null;

  const mediaType = parameterValues(property, 'MEDIATYPE')[0];
  if (mediaType) return mediaType.toLowerCase();
  const type = parameterValues(property, 'TYPE')[0];
  if (!type) return 'image/jpeg';
  const supported = SUPPORTED_PHOTO_MIME_TYPES.get(`image/${type.toLowerCase()}`);
  return supported?.mime || type.toLowerCase();
}

function validatePhoto(property, version) {
  const value = property.rawValue.trim();
  const kind = photoKind(property, version);
  if (kind === 'empty' || kind === 'url') return;
  if (kind === 'base64' || kind === 'legacy-base64') {
    decodeBase64Photo(value);
    return;
  }

  const dataUri = value.match(/^data:([^,]*),(.*)$/is);
  if (!dataUri) throw new Error('vCard PHOTO has invalid data URI encoding');
  if (/(?:^|;)base64(?:;|$)/i.test(dataUri[1])) {
    decodeBase64Photo(dataUri[2]);
    return;
  }
  let decodedBytes;
  try {
    decodedBytes = percentDecodedByteLength(dataUri[2]);
  } catch {
    throw new Error('vCard PHOTO has invalid data URI encoding');
  }
  if (decodedBytes > MAX_PHOTO_BYTES) {
    throw new Error('vCard exceeds the 512 KiB photo limit');
  }
}

function validatedEmbeddedPhoto(property, version) {
  const kind = photoKind(property, version);
  if (kind === 'empty' || kind === 'url') return false;
  validatePhoto(property, version);
  return true;
}

export function parseVCardDocument(raw, { defaultVersion } = {}) {
  const text = raw == null ? '' : String(raw);
  const effectiveDefaultVersion = defaultVersion
    && /^(?:BEGIN:VCARD)(?:\r\n|\n|\r)/i.test(text)
    && !/(?:^|\r\n|\n|\r)VERSION(?:[;:]|$)/i.test(text)
    ? defaultVersion
    : null;
  const lines = unfoldLines(splitPhysicalLines(text));
  const canonicalBytes = lines.reduce((bytes, line, index) => (
    index === lines.length - 1 && line === ''
      ? bytes
      : bytes + byteLength(line) + 2
  ), 0);
  if (canonicalBytes > MAX_VCARD_BYTES) throw new Error('vCard exceeds the 1 MiB limit');

  let state = 'before';
  let version = null;
  let countedProperties = 0;
  const contentLines = [];

  for (const line of lines) {
    if (!line) continue;
    const structural = line.toUpperCase();
    if (state === 'before') {
      if (structural !== 'BEGIN:VCARD') {
        throw new Error('vCard must begin with BEGIN:VCARD');
      }
      state = 'version';
      continue;
    }
    if (state === 'ended') {
      throw new Error('vCard must contain exactly one vCard component');
    }

    const colon = delimiterIndex(line, ':', false);
    const header = colon < 0 ? '' : line.slice(0, colon);
    const structuralName = header.split(';', 1)[0].split('.').at(-1).toUpperCase();
    if (structuralName === 'VERSION' && header.toUpperCase() !== 'VERSION') {
      throw new Error('vCard VERSION parameters are not supported');
    }
    if (/^(?:BEGIN|END)$/.test(structuralName)
      && structural !== 'BEGIN:VCARD'
      && structural !== 'END:VCARD') {
      throw new Error('vCard document cannot contain structural properties');
    }

    if (state === 'version') {
      if (header.toUpperCase() !== 'VERSION') {
        if (!effectiveDefaultVersion) throw new Error('vCard VERSION must follow BEGIN:VCARD');
        version = effectiveDefaultVersion;
        state = 'content';
      } else {
        if (byteLength(line) > MAX_CONTENT_LINE_BYTES) {
          throw new Error('vCard exceeds the 64 KiB unfolded line limit');
        }
        version = line.slice(colon + 1).trim();
        state = 'content';
        continue;
      }
    }

    if (structural === 'END:VCARD') {
      state = 'ended';
      continue;
    }
    if (structural === 'BEGIN:VCARD') {
      throw new Error('vCard must contain exactly one vCard component');
    }
    countedProperties++;
    if (countedProperties > MAX_PROPERTIES) {
      throw new Error('vCard exceeds the 2,000 properties limit');
    }
    if (header.toUpperCase() === 'VERSION') {
      throw new Error('vCard must contain exactly one VERSION property');
    }
    contentLines.push(line);
  }

  if (state === 'before') throw new Error('vCard must begin with BEGIN:VCARD');
  if (state === 'version' && effectiveDefaultVersion) {
    version = effectiveDefaultVersion;
    state = 'content';
  }
  if (state === 'version') throw new Error('vCard VERSION must follow BEGIN:VCARD');
  if (state !== 'ended') throw new Error('vCard must end with END:VCARD');

  if (version !== '3.0' && version !== '4.0') {
    throw new Error('vCard version must be 3.0 or 4.0');
  }

  const properties = [];
  for (const line of contentLines) {
    const property = parseContentLine(line, version);
    const embeddedPhoto = property.name === 'PHOTO'
      && validatedEmbeddedPhoto(property, version);
    if (!embeddedPhoto && byteLength(line) > MAX_CONTENT_LINE_BYTES) {
      throw new Error('vCard exceeds the 64 KiB unfolded line limit');
    }
    properties.push(property);
  }

  return { version, properties };
}

function encodeParameterValue(value, version) {
  const text = String(value);
  if (version !== '4.0') {
    if (hasInvalidParameterValue(text, version)) {
      throw new Error('vCard parameter value contains an invalid character');
    }
    return text;
  }
  let encoded = '';

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (hasForbiddenParameterControl(character, version)) {
      throw new Error('vCard parameter value contains an invalid character');
    }
    if (character === '^') encoded += '^^';
    else if (character === '"') encoded += "^'";
    else if (character === '\r') {
      if (text[index + 1] === '\n') index++;
      encoded += '^n';
    } else if (character === '\n') encoded += '^n';
    else encoded += character;
  }
  return encoded;
}

function serializeParameter(parameter, version) {
  const name = String(parameter.name || '').toUpperCase();
  if (!VCARD_TOKEN.test(name)) throw new Error('vCard contains an invalid parameter name');
  const values = (parameter.values || []).map(value => {
    const encoded = encodeParameterValue(value, version);
    return /[\\,;:"]/.test(encoded) || /^\s|\s$/.test(encoded)
      ? `"${encoded}"`
      : encoded;
  });
  return `${name}=${values.join(',')}`;
}

function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return `${line}\r\n`;

  const parts = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const width = first ? 75 : 74;
    let end = Math.min(offset + width, bytes.length);
    while (end > offset && end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--;
    parts.push(`${first ? '' : ' '}${bytes.subarray(offset, end).toString('utf8')}`);
    offset = end;
    first = false;
  }
  return `${parts.join('\r\n')}\r\n`;
}

function serializeProperty(property, version) {
  const groupName = property.group ? String(property.group) : '';
  if (groupName && !VCARD_TOKEN.test(groupName)) {
    throw new Error('vCard contains an invalid property group');
  }
  const group = groupName ? `${groupName}.` : '';
  const name = String(property.name || '').toUpperCase();
  if (!VCARD_TOKEN.test(name)) throw new Error('vCard contains an invalid property name');
  if (/^(?:BEGIN|END|VERSION)$/.test(name)) {
    throw new Error('vCard document cannot contain structural properties');
  }
  const params = property.params || [];
  if (params.length > MAX_PARAMETERS) {
    throw new Error('vCard property exceeds the 64 parameters limit');
  }

  const rawValue = String(property.rawValue ?? '');
  if (/[\r\n]/.test(rawValue)) {
    throw new Error('vCard property value contains a line break');
  }
  const header = [group + name, ...params.map(parameter => (
    serializeParameter(parameter, version)
  ))].join(';');
  const lineBytes = byteLength(header) + 1 + byteLength(rawValue);
  if (lineBytes + 2 > MAX_VCARD_BYTES) {
    throw new Error('vCard exceeds the 1 MiB limit');
  }
  return { name, params, header, rawValue, lineBytes };
}

export function serializeVCardDocument(document) {
  const version = String(document?.version || '3.0');
  if (version !== '3.0' && version !== '4.0') {
    throw new Error('vCard version must be 3.0 or 4.0');
  }

  const properties = document?.properties || [];
  if (properties.length > MAX_PROPERTIES) {
    throw new Error('vCard exceeds the 2,000 properties limit');
  }

  let canonicalBytes = 0;
  let serialized = '';
  const appendLine = (line, lineBytes, property = null) => {
    if (canonicalBytes + lineBytes + 2 > MAX_VCARD_BYTES) {
      throw new Error('vCard exceeds the 1 MiB limit');
    }
    canonicalBytes += lineBytes + 2;
    const embeddedPhoto = property?.name === 'PHOTO'
      && validatedEmbeddedPhoto(property, version);
    if (property && !embeddedPhoto && lineBytes > MAX_CONTENT_LINE_BYTES) {
      throw new Error('vCard exceeds the 64 KiB unfolded line limit');
    }
    serialized += foldLine(line);
  };

  appendLine('BEGIN:VCARD', byteLength('BEGIN:VCARD'));
  appendLine(`VERSION:${version}`, byteLength(`VERSION:${version}`));
  for (const property of properties) {
    const encoded = serializeProperty(property, version);
    appendLine(`${encoded.header}:${encoded.rawValue}`, encoded.lineBytes, encoded);
  }
  appendLine('END:VCARD', byteLength('END:VCARD'));
  return serialized;
}
