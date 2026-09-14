import { describe, expect, it } from 'vitest';
import { renderCalendarInvite } from './messageParser.js';

// Shape of a real Outlook meeting forward, with made-up people and subject:
// folded lines (tab continuation), quoted TZID with spaces, a quoted CN with a
// comma inside, escaped commas/newlines, and the X-ALT-DESC HTML form.
const OUTLOOK_ICS = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:Eastern Standard Time',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ATTENDEE;CN="\'Alex R\'";RSVP=TRUE:mailto:alex@example.com',
  'DESCRIPTION: \\n\\n-----Original Appointment-----\\nFrom: Doe\\, Jordan',
  '\t P. <jordan@example.com>\\nWhere: Microsoft Teams Meeting\\n',
  'DTEND;TZID="Eastern Standard Time":20260901T143000',
  'DTSTART;TZID="Eastern Standard Time":20260901T140000',
  'LOCATION:Microsoft Teams Meeting',
  'ORGANIZER;CN="Doe, Jordan P.":mailto:jordan@example.com',
  'SUMMARY;LANGUAGE=en-us:FW: Quarterly Review: Relationship Management Introduc',
  '\ttion',
  'X-ALT-DESC;FMTTYPE=text/html:<html><body><p>Join: <a href="https://teams.e',
  '\txample.com/meet/1">link</a></p></body></html>',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const vcalendar = (...eventLines) => [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  ...eventLines,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('renderCalendarInvite', () => {
  it('renders a summary card from a folded, escaped Outlook invite', () => {
    const invite = renderCalendarInvite(OUTLOOK_ICS);
    expect(invite).not.toBeNull();
    expect(invite.html).toContain('Meeting invitation');
    // Folded SUMMARY line reassembled across the tab continuation.
    expect(invite.html).toContain('FW: Quarterly Review: Relationship Management Introduction');
    expect(invite.html).toContain('Tuesday, September 1, 2026, 2:00 PM – 2:30 PM (Eastern Standard Time)');
    expect(invite.html).toContain('Where:</b> Microsoft Teams Meeting');
    // Quoted CN param with a comma inside survives; mailto: prefix stripped.
    expect(invite.html).toContain('Doe, Jordan P. &lt;jordan@example.com&gt;');
  });

  it('prefers the X-ALT-DESC HTML form of the description', () => {
    const invite = renderCalendarInvite(OUTLOOK_ICS);
    expect(invite.html).toContain('href="https://teams.example.com/meet/1"');
    // The escaped plain DESCRIPTION is not doubled in when HTML exists.
    expect(invite.html).not.toContain('-----Original Appointment-----');
    // The text form keeps the plain description with unescaped newlines/commas.
    expect(invite.text).toContain('-----Original Appointment-----');
    expect(invite.text).toContain('From: Doe, Jordan P. <jordan@example.com>');
  });

  it('falls back to the escaped plain DESCRIPTION when no HTML form exists', () => {
    const ics = OUTLOOK_ICS.split('\r\n')
      .filter(l => !l.startsWith('X-ALT-DESC') && !l.includes('xample.com/meet/1'))
      .join('\r\n');
    const invite = renderCalendarInvite(ics);
    expect(invite.html).toContain('-----Original Appointment-----');
    expect(invite.html).toContain('From: Doe, Jordan P.');
    // Angle brackets in the description are escaped, not parsed as HTML.
    expect(invite.html).toContain('&lt;jordan@example.com&gt;');
  });

  it('returns null for non-calendar and eventless input', () => {
    expect(renderCalendarInvite('hello world')).toBeNull();
    expect(renderCalendarInvite('')).toBeNull();
    expect(renderCalendarInvite('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR')).toBeNull();
  });

  it('labels a cancellation and marks UTC times', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'SUMMARY:Board sync',
      'DTSTART:20261005T183000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const invite = renderCalendarInvite(ics);
    expect(invite.html).toContain('Meeting cancelled');
    expect(invite.html).toContain('Monday, October 5, 2026, 6:30 PM UTC');
  });

  it('reads quoted parameters that contain colons or semicolons', () => {
    const invite = renderCalendarInvite(vcalendar(
      'SUMMARY:Budget review',
      'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260901T140000',
      'DTEND;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260901T150000',
      'ORGANIZER;CN="Finance; Planning Team":mailto:planning@example.com',
    ));
    // The TZID already carries parentheses, so it is not wrapped in another pair.
    expect(invite.text).toContain('When: Tuesday, September 1, 2026, 2:00 PM – 3:00 PM (UTC-05:00) Eastern Time (US & Canada)');
    expect(invite.text).toContain('Organizer: Finance; Planning Team <planning@example.com>');
  });

  it('ignores alarm properties nested inside the event', () => {
    const invite = renderCalendarInvite(vcalendar(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:REMINDER',
      'TRIGGER;RELATED=START:-PT15M',
      'END:VALARM',
      'SUMMARY:Staff meeting',
      'DTSTART:20261005T183000Z',
    ));
    expect(invite.html).toContain('Staff meeting');
    expect(invite.text).not.toContain('REMINDER');
  });

  it('treats an all-day DTEND as exclusive', () => {
    const allDay = (end) => renderCalendarInvite(vcalendar(
      'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20261224',
      `DTEND;VALUE=DATE:${end}`,
    ));
    // A one-day event ends on the following date, so it shows a single date.
    expect(allDay('20261225').text).toMatch(/^When: Thursday, December 24, 2026$/m);
    expect(allDay('20261227').text).toContain('When: Thursday, December 24, 2026 – Saturday, December 26, 2026');
  });

  it('unescapes TEXT values in a single pass', () => {
    const invite = renderCalendarInvite(vcalendar(
      'SUMMARY:Shared drive move',
      'DESCRIPTION:Files move to S:\\\\new\\nThen update links\\; thanks',
    ));
    // An escaped backslash before "n" is a literal backslash, not a line break.
    expect(invite.text).toContain('Files move to S:\\new\nThen update links; thanks');
  });
});
