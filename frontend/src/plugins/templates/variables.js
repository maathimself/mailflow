import DOMPurify from 'dompurify';

export const NAME_VARIABLES = ['contact.fullName', 'contact.givenName', 'contact.surname'];
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;
export const recipientAddress = recipient => (recipient?.match(/<([^<>]+)>$/)?.[1] || recipient || '').trim().toLowerCase();
export const needsContact = text => [...text.matchAll(TOKEN)].some(([, name]) => NAME_VARIABLES.includes(name));

function nameValues(contact) {
  return {
    'contact.fullName': contact?.display_name || [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    'contact.givenName': contact?.first_name,
    'contact.surname': contact?.last_name,
  };
}

function variableValues({ contact, now = new Date(), locale } = {}) {
  return {
    'date.date': new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(now),
    'date.longDate': new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(now),
    'date.dateTime': new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(now),
    'date.month': new Intl.DateTimeFormat(locale, { month: 'long' }).format(now),
    ...nameValues(contact),
  };
}

export function fillSubject(subject, options) {
  const values = variableValues(options);
  return subject.replace(TOKEN, (token, name) => Object.hasOwn(values, name) && values[name] ? values[name] : token)
    .replace(/[\r\n]+/g, ' ').slice(0, 2000);
}

export function fillNames(text, contact) {
  if (!needsContact(text)) return text;
  const values = nameValues(contact);
  return text.replace(TOKEN, (token, name) => NAME_VARIABLES.includes(name) && values[name] ? values[name] : token);
}

export function fillNameHtml(html, contact) {
  const container = document.createElement('div');
  container.innerHTML = DOMPurify.sanitize(html || '');
  const walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */);
  let changed = false;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const next = fillNames(node.textContent, contact);
    if (next !== node.textContent) { node.textContent = next; changed = true; }
  }
  return changed ? container.innerHTML : html;
}

// Substitute text nodes only: contact data can never become markup or a link destination.
export function fillVariables(html, options) {
  const values = variableValues(options);
  const container = document.createElement('div');
  container.innerHTML = DOMPurify.sanitize(html || '');
  const walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */);
  while (walker.nextNode()) {
    walker.currentNode.textContent = walker.currentNode.textContent.replace(TOKEN,
      (token, name) => Object.hasOwn(values, name) && values[name] ? values[name] : token);
  }
  return container.innerHTML;
}

export async function findRecipientContact(api, recipient) {
  const address = recipientAddress(recipient);
  if (!address || !address.includes('@')) return null;
  const { contacts = [] } = await api.getContacts({ q: address, limit: 500 });
  const matches = contacts.filter(contact => [contact.primary_email, ...(contact.emails || []).map(email => email.value)]
    .some(email => email?.trim().toLowerCase() === address));
  // Explicit address-book entries take precedence over automatically collected contacts.
  return matches.find(contact => !contact.is_auto) || matches[0] || null;
}
