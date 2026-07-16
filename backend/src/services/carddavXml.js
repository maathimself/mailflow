import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const DAV_NS = 'DAV:';
export const CARDDAV_NS = 'urn:ietf:params:xml:ns:carddav';
export const DAV_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const DAV_MAX_ENTITY_EXPANSIONS = 1_000_000;

const parser = new XMLParser({
  preserveOrder: true,
  removeNSPrefix: false,
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  maxNestedTags: 100,
  processEntities: {
    enabled: true,
    maxEntitySize: 10_000,
    maxExpansionDepth: 10,
    maxTotalExpansions: DAV_MAX_ENTITY_EXPANSIONS,
    maxExpandedLength: DAV_MAX_RESPONSE_BYTES,
    maxEntityCount: 100,
  },
});

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseXmlDocument(xmlText, label = 'XML document') {
  if (typeof xmlText !== 'string' || xmlText.length === 0) {
    throw new Error(`${label} was not valid XML: document is empty`);
  }
  if (/<!DOCTYPE(?=[\s>])/i.test(xmlText)) {
    throw new Error(`${label} must not contain a DOCTYPE`);
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    throw new Error(`${label} was not valid XML: ${validation.err.msg}`);
  }

  let orderedDocument;
  try {
    orderedDocument = parser.parse(xmlText);
  } catch (error) {
    throw new Error(`${label} could not be parsed: ${error.message}`, { cause: error });
  }

  const roots = [];
  for (const entry of orderedDocument) {
    if (!elementQName(entry)) continue;
    roots.push(resolveElement(entry, new Map([['xml', XML_NS]]), label));
  }
  if (roots.length !== 1) {
    throw new Error(`${label} must contain exactly one top-level element`);
  }
  return roots[0];
}

export function parseDavMultistatus(xmlText, label = 'response') {
  const root = parseXmlDocument(xmlText, label);
  if (!isNamed(root, DAV_NS, 'multistatus')) {
    throw new Error(`CardDAV ${label} was not a valid DAV multistatus`);
  }
  return root;
}

export function childrenNamed(node, namespaceURI, localName) {
  if (!Array.isArray(node?.children)) return [];
  return node.children.filter(child => isNamed(child, namespaceURI, localName));
}

export function onlyChildNamed(node, namespaceURI, localName, label = describeNode(node)) {
  const matches = childrenNamed(node, namespaceURI, localName);
  if (matches.length !== 1) {
    throw new Error(
      `${label} must contain exactly one ${describeName(namespaceURI, localName)} child; found ${matches.length}`,
    );
  }
  return matches[0];
}

export function textOfNode(node) {
  return typeof node?.text === 'string' ? node.text : '';
}

export function parseDavResponse(responseNode, label = 'DAV response') {
  if (!isNamed(responseNode, DAV_NS, 'response')) {
    throw new Error(`${label} was not a DAV response element`);
  }

  const href = textOfNode(onlyChildNamed(responseNode, DAV_NS, 'href', label));
  const statusNodes = childrenNamed(responseNode, DAV_NS, 'status');
  const propstatNodes = childrenNamed(responseNode, DAV_NS, 'propstat');
  const hasStatus = statusNodes.length > 0;
  const hasPropstats = propstatNodes.length > 0;

  if (hasStatus === hasPropstats) {
    throw new Error(
      `${label} must contain either one DAV status or one or more DAV propstat children, but not both`,
    );
  }

  if (hasStatus) {
    const statusNode = onlyChildNamed(responseNode, DAV_NS, 'status', label);
    return {
      href,
      status: parseStatusCode(statusNode, label),
      propstats: [],
    };
  }

  const propstats = propstatNodes.map((propstatNode, index) => {
    const propstatLabel = `${label} propstat ${index + 1}`;
    const propNode = onlyChildNamed(propstatNode, DAV_NS, 'prop', propstatLabel);
    const statusNode = onlyChildNamed(propstatNode, DAV_NS, 'status', propstatLabel);
    return {
      status: parseStatusCode(statusNode, propstatLabel),
      properties: propNode.children,
    };
  });

  return { href, status: null, propstats };
}

export function successfulProperties(response) {
  if (!Array.isArray(response?.propstats)) {
    throw new TypeError('successfulProperties requires a parsed DAV response');
  }
  return response.propstats
    .filter(({ status }) => status >= 200 && status < 300)
    .flatMap(({ properties }) => properties);
}

export function parseDavErrorPrecondition(xmlText) {
  if (!xmlText) return null;
  try {
    const root = parseXmlDocument(xmlText, 'DAV error response');
    if (!isNamed(root, DAV_NS, 'error')) return null;
    return root.children.find(child => isNamed(child, DAV_NS, 'valid-sync-token'))?.localName ?? null;
  } catch {
    return null;
  }
}

function resolveElement(entry, inheritedNamespaces, label) {
  const qName = elementQName(entry);
  const namespaces = new Map(inheritedNamespaces);
  const attributes = Object.entries(entry[':@'] || {}).map(([rawName, value]) => ({
    name: rawName.startsWith('@_') ? rawName.slice(2) : rawName,
    value,
  }));

  for (const { name, value } of attributes) {
    const declaredPrefix = namespaceDeclarationPrefix(name, label);
    if (declaredPrefix === null) continue;
    validateNamespaceDeclaration(declaredPrefix, value, label);
    namespaces.set(declaredPrefix, value);
  }
  const resolvedAttributes = [];
  for (const { name, value } of attributes) {
    if (namespaceDeclarationPrefix(name, label) !== null) continue;
    const { prefix, localName: attributeLocalName } = splitQName(name, label);
    if (prefix && (!namespaces.has(prefix) || namespaces.get(prefix) === '')) {
      throw new Error(`${label} uses unbound namespace prefix "${prefix}"`);
    }
    resolvedAttributes.push({
      namespaceURI: prefix ? namespaces.get(prefix) : null,
      localName: attributeLocalName,
      value,
    });
  }

  const { prefix, localName } = splitQName(qName, label);
  let namespaceURI = null;
  if (prefix) {
    if (!namespaces.has(prefix) || namespaces.get(prefix) === '') {
      throw new Error(`${label} uses unbound namespace prefix "${prefix}"`);
    }
    namespaceURI = namespaces.get(prefix);
  } else if (namespaces.has('') && namespaces.get('') !== '') {
    namespaceURI = namespaces.get('');
  }

  const children = [];
  let text = '';
  for (const childEntry of entry[qName] || []) {
    if (Object.hasOwn(childEntry, '#text')) {
      text += childEntry['#text'];
      continue;
    }
    if (elementQName(childEntry)) {
      children.push(resolveElement(childEntry, namespaces, label));
    }
  }

  return { namespaceURI, localName, attributes: resolvedAttributes, children, text };
}

function namespaceDeclarationPrefix(attributeName, label) {
  if (attributeName === 'xmlns') return '';
  if (attributeName === 'xmlns:') {
    throw new Error(`${label} contains invalid namespace declaration "xmlns:"`);
  }
  if (attributeName.startsWith('xmlns:')) return attributeName.slice('xmlns:'.length);
  return null;
}

function validateNamespaceDeclaration(prefix, namespaceURI, label) {
  if (prefix.includes(':')) {
    throw new Error(`${label} contains invalid namespace declaration "xmlns:${prefix}"`);
  }
  if (prefix === 'xmlns') {
    throw new Error(`${label} cannot declare the reserved namespace prefix "xmlns"`);
  }
  if (prefix === 'xml') {
    if (namespaceURI !== XML_NS) {
      throw new Error(`${label} cannot rebind the reserved namespace prefix "xml"`);
    }
    return;
  }
  if (namespaceURI === XML_NS || namespaceURI === XMLNS_NS) {
    throw new Error(`${label} cannot bind a reserved namespace URI to "${prefix}"`);
  }
  if (prefix && namespaceURI === '') {
    throw new Error(`${label} cannot undeclare namespace prefix "${prefix}"`);
  }
}

function elementQName(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const names = Object.keys(entry).filter(name => name !== ':@' && name !== '#text');
  return names.length === 1 ? names[0] : null;
}

function splitQName(qName, label) {
  const parts = qName.split(':');
  if (parts.length === 1) return { prefix: '', localName: qName };
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`${label} contains invalid qualified name "${qName}"`);
  }
  return { prefix: parts[0], localName: parts[1] };
}

function parseStatusCode(statusNode, label) {
  const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/i.exec(textOfNode(statusNode));
  if (!match) throw new Error(`${label} must contain a parseable DAV status`);
  return Number(match[1]);
}

function isNamed(node, namespaceURI, localName) {
  return node?.namespaceURI === namespaceURI && node?.localName === localName;
}

function describeNode(node) {
  return node ? describeName(node.namespaceURI, node.localName) : 'XML element';
}

function describeName(namespaceURI, localName) {
  return namespaceURI === DAV_NS ? `DAV ${localName}` : `{${namespaceURI ?? ''}}${localName}`;
}
