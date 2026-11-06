import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({ stored: '', puts: [], dropOnFirstPut: true, alwaysDrop: false }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/caldavSync.js', () => ({ syncAccount: vi.fn(), credentialsFor: vi.fn(), isSyncing: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_q, _r, n) => n() }));
vi.mock('../services/caldavClient.js', () => ({
  discoverCalendars: vi.fn(), findCalDavServer: vi.fn(), deleteEvent: vi.fn(),
  putEvent: vi.fn(async (_href, ical, _creds, { etag }) => {
    server.puts.push(etag);
    const drop = server.alwaysDrop || (server.dropOnFirstPut && server.puts.length === 1);
    server.stored = drop ? ical.replace(/EXDATE[^\r\n]*\r\n/, '') : ical;
  }),
  getEvent: vi.fn(async () => ({ etag: `"v${server.puts.length}"`, ical: server.stored })),
}));

const { putKeepingMarkers } = await import('./calendar.js');

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20261103T090000Z', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

describe('putKeepingMarkers', () => {
  beforeEach(() => { Object.assign(server, { stored: '', puts: [], dropOnFirstPut: true, alwaysDrop: false }); });

  it('sends the series again, under the new etag, when the server dropped an exclusion', async () => {
    await putKeepingMarkers('https://x/a.ics', ICS, {}, '"old"');
    expect(server.puts).toEqual(['"old"', '"v1"']);
    expect(server.stored).toContain('EXDATE');
  });

  it('writes once when the server kept them', async () => {
    server.dropOnFirstPut = false;
    await putKeepingMarkers('https://x/a.ics', ICS, {}, '"old"');
    expect(server.puts).toEqual(['"old"']);
  });

  it('warns, and stops, when the server will not take them back', async () => {
    server.alwaysDrop = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putKeepingMarkers('https://x/a.ics', ICS, {}, '"old"');
    expect(server.puts).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped exceptions'));
    warn.mockRestore();
  });
});
