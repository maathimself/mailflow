import addressparser from 'nodemailer/lib/addressparser/index.js';
import { parseDocument, DomUtils } from 'htmlparser2';
import { getOwnedContactByEmail, isPluginActivated } from '../api.js';

const TOKEN = /\{\{\s*((?:date|contact|address|email|phone)\.[\w.]+)\s*\}\}/g;
const PLACEHOLDER = /\{\{\s*add\s+placeholder\s*\}\}/;
const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const problem = message => Object.assign(new Error(message), { status: 400 });

function split(value, separator) {
  const parts = [''];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[++i]; parts[parts.length - 1] += /n/i.test(next) ? '\n' : next;
    } else if (value[i] === separator) parts.push('');
    else parts[parts.length - 1] += value[i];
  }
  return parts.map(part => part.trim());
}

function contactValues(contact, recipient) {
  const properties = [];
  for (const line of (contact?.vcard || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const header = line.slice(0, colon);
    properties.push({ name: header.split(';')[0].split('.').pop().toUpperCase(),
      types: (header.match(/(?:^|;)TYPE=([^;]+)/i)?.[1] || '').replace(/"/g, '').toLowerCase().split(','), raw: line.slice(colon + 1) });
  }
  const property = (name, type) => properties.find(item => item.name === name && (!type || item.types.includes(type)));
  const text = (name, type) => split(property(name, type)?.raw || '', '\0').join('');
  const name = split(property('N')?.raw || '', ';');
  const first = contact?.first_name || name[1] || '';
  const last = contact?.last_name || name[0] || '';
  const address = type => {
    const parts = split(property('ADR', type)?.raw || '', ';');
    const city = [parts[3], [parts[4], parts[5]].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [...parts.slice(0, 3), city, parts[6]].filter(Boolean).join('\n');
  };
  const typed = (items, types) => items?.find(item => String(item.type || '').toLowerCase().split(',').some(type => types.includes(type)))?.value;
  const phone = types => String(typed(contact?.phones, types) || types.map(type => text('TEL', type)).find(Boolean) || '').replace(/^tel:/i, '');
  const home = address('home'), work = address('work');
  return {
    'contact.fullName': text('FN') || [first, last].filter(Boolean).join(' ') || contact?.display_name || recipient.name,
    'contact.givenName': first, 'contact.surname': last,
    'contact.salutation': text('X-SALUTATION') || text('X-EVOLUTION-SALUTATION') || name[3],
    'contact.prefix': name[3], 'contact.suffix': name[4], 'contact.title': text('TITLE'),
    'contact.company': contact?.organization || split(property('ORG')?.raw || '', ';')[0],
    'address.home': home, 'address.homeInline': home.replace(/\n/g, ', '),
    'address.work': work, 'address.workInline': work.replace(/\n/g, ', '),
    'email.address': recipient.address,
    'email.displayAs': contact?.display_name || text('FN') || recipient.name || recipient.address,
    'email.work': typed(contact?.emails, ['work']) || text('EMAIL', 'work').replace(/^mailto:/i, ''),
    'phone.mobile': phone(['cell', 'mobile']), 'phone.home': phone(['home']), 'phone.work': phone(['work']),
  };
}

export async function expandOutgoingVariables({ userId, input, date, value }) {
  const document = value.bodyIsHtml && (value.body || '').includes('{{') ? parseDocument(value.body) : null;
  const source = `${value.subject || ''}\n${value.body || ''}\n${document ? DomUtils.textContent(document) : ''}`;
  if (!source.match(TOKEN) && !PLACEHOLDER.test(source)) return value;
  if (!await isPluginActivated(userId, 'templates')) return value;
  if (PLACEHOLDER.test(source)) throw problem('Fill in the template placeholder before sending.');
  let locale = ({ ptBR: 'pt-BR', zhCN: 'zh-CN' })[input.locale] || input.locale || 'en';
  let timeZone = input.timeZone || 'UTC';
  try { new Intl.DateTimeFormat(locale); } catch { locale = 'en'; }
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { timeZone = 'UTC'; }
  const format = options => new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  const values = {
    'date.date': format({ dateStyle: 'short' }), 'date.longDate': format({ dateStyle: 'long' }),
    'date.dateTime': format({ dateStyle: 'short', timeStyle: 'short' }), 'date.month': format({ month: 'long' }),
  };
  if ([...source.matchAll(TOKEN)].some(match => !match[1].startsWith('date.'))) {
    const recipient = addressparser(input.recipient || input.to?.[0] || '', { flatten: true })[0] || {};
    const contact = await getOwnedContactByEmail(userId, recipient.address);
    Object.assign(values, contactValues(contact, recipient));
  }
  const replace = (text, html = false) => String(text || '').replace(TOKEN, (_token, key) => {
    if (!(key in values) || !String(values[key] || '').trim()) throw problem(`Template variable {{ ${key} }} has no value for ${input.recipient || input.to?.[0] || 'the recipient'}. Update the contact or replace the variable before sending.`);
    const result = String(values[key]).replace(/\r/g, '');
    return html ? escapeHtml(result).replace(/\n/g, '<br>') : result;
  });
  let body;
  if (value.bodyIsHtml) {
    const htmlDocument = document || parseDocument(value.body || '');
    const visit = parent => {
      parent.children = parent.children.flatMap(node => {
        if (node.type === 'text' && node.data.match(TOKEN)) {
          // Escape the original text too: contact values must never become HTML or attributes.
          const nodes = parseDocument(replace(escapeHtml(node.data), true)).children;
          nodes.forEach(child => { child.parent = parent; });
          return nodes;
        }
        if (node.children && !['script', 'style'].includes(node.name)) visit(node);
        return [node];
      });
    };
    visit(htmlDocument); body = DomUtils.getOuterHTML(htmlDocument);
    if (body.match(TOKEN) || DomUtils.textContent(htmlDocument).match(TOKEN)) throw problem('Keep each template variable together in message text, outside HTML attributes or markup.');
  } else body = replace(value.body);
  const personalize = [...source.matchAll(TOKEN)].some(match => !match[1].startsWith('date.'));
  return { ...value, body, subject: replace(value.subject).replace(/[\r\n\0]/g, ''), ...(personalize ? { personalize: true } : {}) };
}
