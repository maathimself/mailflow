import {
  contactFromVCardDocument,
  overlayContactOnVCard,
  parseVCardDocument,
  serializeVCardDocument,
} from './vcardProperties.js';

/**
 * Parse a vCard into the compatibility contact shape used outside CardDAV sync.
 */
export function parseVCard(raw) {
  const text = raw == null ? '' : String(raw);
  const document = parseVCardDocument(text, { defaultVersion: '3.0' });
  const contact = contactFromVCardDocument(document);
  if (contact.emails.length && !contact.emails.some(email => email.primary)) {
    contact.emails[0].primary = true;
  }
  return contact;
}

/**
 * Generate a deterministic vCard 3.0 for general-purpose contact consumers.
 */
export function generateVCard(contact) {
  const firstName = contact.firstName ?? contact.first_name;
  const lastName = contact.lastName ?? contact.last_name;
  const email = contact.emails?.[0]?.value ?? contact.emails?.[0]?.email ?? '';
  const displayName = contact.displayName ?? contact.display_name;
  const emails = (contact.emails || []).map(emailEntry => {
    const entry = { ...emailEntry };
    delete entry.primary;
    delete entry.isPrimary;
    delete entry.is_primary;
    return entry;
  });
  const compatibilityContact = {
    ...contact,
    emails,
    displayName: displayName
      || ([firstName, lastName].filter(Boolean).join(' ') || email),
  };
  const document = overlayContactOnVCard({
    version: '3.0',
    properties: [
      { group: null, name: 'UID', params: [], rawValue: '' },
      { group: null, name: 'FN', params: [], rawValue: '' },
    ],
  }, compatibilityContact);
  return serializeVCardDocument(document);
}
