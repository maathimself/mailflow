import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../api.js', () => ({ getOwnedContactByEmail: vi.fn(), isPluginActivated: vi.fn() }));
import { getOwnedContactByEmail, isPluginActivated } from '../api.js';
import { expandOutgoingVariables } from './variables.js';

const date = new Date('2026-10-29T01:30:00Z');
const contact = {
  first_name: 'Ada', last_name: 'Lovelace', display_name: 'Ada Lovelace', organization: 'Engine & Co',
  emails: [{ type: 'work', value: 'ada@work.test' }], phones: [{ type: 'cell', value: '123' }, { type: 'home', value: '456' }, { type: 'work', value: '789' }],
  vcard: 'BEGIN:VCARD\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;Dr.;PhD\r\nTITLE:Engineer\r\nX-SALUTATION:Dear Ada\r\nADR;TYPE=HOME:;;1 Main St;Halifax;NS;B1B 1B1;Canada\r\nADR;TYPE=WORK:;;2 Work St;London;;NW1;UK\r\nEND:VCARD',
};
const expand = (body, extra = {}) => expandOutgoingVariables({
  userId: 'u1', date, input: { to: ['Ada <ada@example.test>'], locale: 'en-CA', timeZone: 'America/Halifax' },
  value: { subject: '', body, bodyIsHtml: false }, ...extra,
});
beforeEach(() => { vi.clearAllMocks(); isPluginActivated.mockResolvedValue(true); getOwnedContactByEmail.mockResolvedValue(contact); });

describe('template send-time variables', () => {
  it('uses the attempt time in the sender timezone and language without querying contacts for date-only messages', async () => {
    const result = await expand('{{ date.date }}|{{date.longDate}}|{{ date.dateTime }}|{{ date.month }}');
    const format = options => new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'America/Halifax' }).format(date);
    expect(result.body).toBe([format({ dateStyle: 'short' }), format({ dateStyle: 'long' }), format({ dateStyle: 'short', timeStyle: 'short' }), 'October'].join('|'));
    expect(result.body).toContain('28');
    expect(getOwnedContactByEmail).not.toHaveBeenCalled();
  });
  it('resolves all contact, email, phone and address fields for the current delivery recipient', async () => {
    const keys = ['contact.fullName', 'contact.givenName', 'contact.surname', 'contact.salutation', 'contact.prefix', 'contact.suffix', 'contact.title', 'contact.company',
      'address.home', 'address.homeInline', 'address.work', 'address.workInline', 'email.address', 'email.displayAs', 'email.work', 'phone.mobile', 'phone.home', 'phone.work'];
    const result = await expand(keys.map(key => `{{ ${key} }}`).join('|'));
    expect(getOwnedContactByEmail).toHaveBeenCalledWith('u1', 'ada@example.test');
    expect(result.body.split('|')).toEqual(['Ada Lovelace', 'Ada', 'Lovelace', 'Dear Ada', 'Dr.', 'PhD', 'Engineer', 'Engine & Co',
      '1 Main St\nHalifax, NS B1B 1B1\nCanada', '1 Main St, Halifax, NS B1B 1B1, Canada', '2 Work St\nLondon, NW1\nUK', '2 Work St, London, NW1, UK',
      'ada@example.test', 'Ada Lovelace', 'ada@work.test', '123', '456', '789']);
  });
  it('escapes contact text in HTML and converts multiline addresses to line breaks', async () => {
    getOwnedContactByEmail.mockResolvedValue({ ...contact, first_name: '<img src=x onerror=alert(1)> & Hi' });
    const result = await expand('', { value: { subject: '{{ contact.givenName }}', body: '<p>{{ contact.givenName }}</p><p>{{ address.home }}</p>', bodyIsHtml: true } });
    expect(result.body).toContain('&lt;img'); expect(result.body).not.toContain('<img');
    expect(result.body).toMatch(/1 Main St<br\s*\/?>(Halifax)/);
    expect(result.subject).toContain('<img');
  });
  it('recognizes HTML-encoded whitespace and refuses tokens split by formatting instead of sending them unchanged', async () => {
    const result = await expand('', { value: { subject: '', body: '<p>{{&nbsp;contact.givenName&nbsp;}}</p>', bodyIsHtml: true } });
    expect(result.body).toBe('<p>Ada</p>');
    await expect(expand('', { value: { subject: '', body: '<p>{{ contact.<b>givenName</b> }}</p>', bodyIsHtml: true } })).rejects.toMatchObject({ status: 400 });
  });
  it('stops missing values, unknown variables and unfilled placeholders before sending', async () => {
    getOwnedContactByEmail.mockResolvedValue(null);
    for (const body of ['{{ contact.givenName }}', '{{ address.work }}', '{{ date.unknown }}', '{{ add placeholder }}']) {
      await expect(expand(body)).rejects.toMatchObject({ status: 400 });
    }
    await expect(expand('<a href="{{ email.address }}">Link</a>', { value: { subject: '', body: '<a href="{{ email.address }}">Link</a>', bodyIsHtml: true } })).rejects.toMatchObject({ status: 400 });
  });
  it('keeps ordinary mail and disabled plugins unchanged, without contact access', async () => {
    expect((await expand('Hello {{ unrelated }}')).body).toBe('Hello {{ unrelated }}');
    isPluginActivated.mockResolvedValue(false);
    expect((await expand('{{ contact.fullName }}')).body).toBe('{{ contact.fullName }}');
    expect(getOwnedContactByEmail).not.toHaveBeenCalled();
  });
  it('propagates lookup failures rather than sending unresolved variables', async () => {
    getOwnedContactByEmail.mockRejectedValue(new Error('database unavailable'));
    await expect(expand('{{ contact.givenName }}')).rejects.toThrow('database unavailable');
  });
});
