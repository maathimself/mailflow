import { describe, it, expect } from 'vitest';
import { unfoldIcs, unescapeIcsText, parseFirstVevent, renderInviteHtml } from './icsInvite.js';
import { sanitizeEmail } from './emailSanitizer.js';

const ics = (...lines) => lines.join('\r\n') + '\r\n';

const OUTLOOK_REQUEST = ics(
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN="Doe: John":mailto:john.doe@example.com',
  'SUMMARY;LANGUAGE=en-US:Quarterly planning\\, part 2',
  'DTSTART;TZID=W. Europe Standard Time:20260915T100000',
  'DTEND;TZID=W. Europe Standard Time:20260915T113000',
  'LOCATION:Room 4\\; building B',
  'DESCRIPTION;LANGUAGE=en-US:Agenda:\\nItem one\\nJoin: https://teams.microsoft.c',
  ' om/l/meetup-join/abc?x=1&y=2',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:REMINDER',
  'TRIGGER;RELATED=START:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
);

describe('unfoldIcs', () => {
  it('joins CRLF+space and LF+tab continuation lines', () => {
    expect(unfoldIcs('SUMMARY:Hel\r\n lo\nLOCATION:Ro\n\tom\r\n')).toBe('SUMMARY:Hello\nLOCATION:Room\r\n');
  });
});

describe('unescapeIcsText', () => {
  it('unescapes \\n, \\N, \\, \\; and \\\\', () => {
    expect(unescapeIcsText('a\\nb\\Nc\\,d\\;e\\\\f')).toBe('a\nb\nc,d;e\\f');
  });

  it('does not treat an escaped backslash followed by n as a newline', () => {
    expect(unescapeIcsText('C:\\\\new')).toBe('C:\\new');
  });
});

describe('parseFirstVevent', () => {
  it('returns null when there is no VEVENT', () => {
    expect(parseFirstVevent(ics('BEGIN:VCALENDAR', 'BEGIN:VTODO', 'SUMMARY:x', 'END:VTODO', 'END:VCALENDAR'))).toBeNull();
    expect(parseFirstVevent('')).toBeNull();
  });

  it('reads METHOD and the first VEVENT, ignoring VTIMEZONE and VALARM properties', () => {
    const ev = parseFirstVevent(OUTLOOK_REQUEST);
    expect(ev.method).toBe('REQUEST');
    expect(ev.summary).toBe('Quarterly planning, part 2');
    expect(ev.location).toBe('Room 4; building B');
    expect(ev.description).toBe('Agenda:\nItem one\nJoin: https://teams.microsoft.com/l/meetup-join/abc?x=1&y=2');
    expect(ev.dtstart).toMatchObject({ value: '20260915T100000', tzid: 'W. Europe Standard Time' });
  });

  it('parses a quoted parameter containing a colon', () => {
    const ev = parseFirstVevent(OUTLOOK_REQUEST);
    expect(ev.organizer).toEqual({ name: 'Doe: John', email: 'john.doe@example.com' });
  });

  it('uses only the first VEVENT', () => {
    const ev = parseFirstVevent(ics(
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'SUMMARY:First', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Second', 'END:VEVENT',
      'END:VCALENDAR',
    ));
    expect(ev.summary).toBe('First');
  });
});

describe('renderInviteHtml', () => {
  it('returns null for input with no VEVENT', () => {
    expect(renderInviteHtml('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBeNull();
    expect(renderInviteHtml('hello')).toBeNull();
  });

  it('renders the title, a time row with the TZID label, location and organizer', () => {
    const { html, text } = renderInviteHtml(OUTLOOK_REQUEST);
    expect(html).toContain('Quarterly planning, part 2');
    expect(html).toContain('🗓');
    expect(html).toContain('2026-09-15 10:00 – 11:30 (W. Europe Standard Time)');
    expect(html).toContain('📍');
    expect(html).toContain('Room 4; building B');
    expect(html).toContain('👤');
    expect(html).toContain('Doe: John &lt;john.doe@example.com&gt;');
    expect(html).not.toContain('BEGIN:VEVENT');
    expect(html).not.toContain('REMINDER');
    // Language-neutral: no English method labels.
    expect(html).not.toMatch(/invitation|cancel|response|when|where|organizer/i);
    expect(text).toContain('Quarterly planning, part 2');
  });

  it('keeps DESCRIPTION line breaks and makes links clickable', () => {
    const { html } = renderInviteHtml(OUTLOOK_REQUEST);
    expect(html).toContain('Agenda:<br>Item one<br>');
    expect(html).toContain('<a href="https://teams.microsoft.com/l/meetup-join/abc?x=1&amp;y=2">https://teams.microsoft.com/l/meetup-join/abc?x=1&amp;y=2</a>');
  });

  it('prefers X-ALT-DESC;FMTTYPE=text/html over DESCRIPTION', () => {
    const { html } = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'SUMMARY:S',
      'DESCRIPTION:plain body',
      'X-ALT-DESC;FMTTYPE=text/html:<p>rich <b>body</b>\\, here</p>',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(html).toContain('<p>rich <b>body</b>, here</p>');
    expect(html).not.toContain('plain body');
  });

  it('flags Z times as UTC', () => {
    const { html } = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'DTSTART:20260915T080000Z', 'DTEND:20260915T090000Z',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(html).toContain('2026-09-15 08:00 – 09:00 (UTC)');
  });

  it('shows VALUE=DATE events as all-day dates only, with an exclusive DTEND', () => {
    const one = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260915', 'DTEND;VALUE=DATE:20260916',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(one.html).toContain('🗓 2026-09-15<');
    const multi = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261003',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(multi.html).toContain('2026-09-30 – 2026-10-02');
  });

  it('does not throw on an impossible all-day DTEND and still shows the start date', () => {
    let result;
    expect(() => {
      result = renderInviteHtml(ics(
        'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
        'SUMMARY:S', 'DTSTART;VALUE=DATE:20260101', 'DTEND;VALUE=DATE:20261399',
        'END:VEVENT', 'END:VCALENDAR',
      ));
    }).not.toThrow();
    expect(result.html).toContain('🗓 2026-01-01<');
  });

  it('shows only the start when a timed DTEND is garbage', () => {
    const { text } = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'DTSTART:20260915T080000Z', 'DTEND:tomorrow',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(text).toBe('🗓 2026-09-15 08:00 (UTC)');
  });

  it('returns null for a VEVENT with nothing to show', () => {
    expect(renderInviteHtml(ics('BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'END:VEVENT', 'END:VCALENDAR'))).toBeNull();
  });

  it('shows both dates when a timed event spans days', () => {
    const { text } = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'DTSTART;TZID="Europe/Berlin":20260915T230000', 'DTEND;TZID="Europe/Berlin":20260916T010000',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(text).toContain('2026-09-15 23:00 – 2026-09-16 01:00 (Europe/Berlin)');
  });

  it('marks CANCEL with a strikethrough title and ❌, and REPLY with ↩', () => {
    const cancel = renderInviteHtml(OUTLOOK_REQUEST.replace('METHOD:REQUEST', 'METHOD:CANCEL'));
    expect(cancel.html).toContain('❌');
    expect(cancel.html).toMatch(/<s>Quarterly planning, part 2<\/s>/);
    expect(cancel.text).toContain('❌ Quarterly planning, part 2');

    const reply = renderInviteHtml(OUTLOOK_REQUEST.replace('METHOD:REQUEST', 'METHOD:REPLY'));
    expect(reply.html).toContain('↩');
    expect(reply.html).not.toContain('<s>');

    const request = renderInviteHtml(OUTLOOK_REQUEST);
    expect(request.html).not.toMatch(/❌|↩|<s>/);
  });

  it('shows the organizer email alone when there is no CN', () => {
    const { html } = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'ORGANIZER:MAILTO:boss@example.com', 'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(html).toContain('👤 boss@example.com<');
  });

  it('HTML-escapes attacker-controlled SUMMARY, LOCATION, ORGANIZER and DESCRIPTION', () => {
    const { html } = renderInviteHtml(ics(
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
      'SUMMARY:<script>alert(1)</script>',
      'LOCATION:"><img src=x onerror=alert(2)>',
      'ORGANIZER;CN="<b onmouseover=x>":mailto:a@b.c',
      'DESCRIPTION:<iframe src=javascript:alert(3)> https://x.test/"onmouseover="alert(4)',
      'DTSTART;TZID=<i>:20260915T100000',
      'END:VEVENT', 'END:VCALENDAR',
    ));
    expect(html).not.toMatch(/<script|<img|<b |<iframe|<i>/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toContain('"onmouseover');
  });

  it('text is a plain summary without markup', () => {
    const { text } = renderInviteHtml(OUTLOOK_REQUEST);
    expect(text).not.toMatch(/<\/?(?:div|span|br|s|a|p|b)\b/i);
    expect(text.split('\n').slice(0, 4)).toEqual([
      'Quarterly planning, part 2',
      '🗓 2026-09-15 10:00 – 11:30 (W. Europe Standard Time)',
      '📍 Room 4; building B',
      '👤 Doe: John <john.doe@example.com>',
    ]);
    expect(text).toContain('Join: https://teams.microsoft.com/l/meetup-join/abc?x=1&y=2');
  });

  it('keeps the card structure through sanitizeEmail', () => {
    const cancel = renderInviteHtml(OUTLOOK_REQUEST.replace('METHOD:REQUEST', 'METHOD:CANCEL'));
    const safe = sanitizeEmail(cancel.html);
    expect(safe).toMatch(/<div style="[^"]*border[^"]*">/);
    expect(safe).toMatch(/<s>Quarterly planning, part 2<\/s>/);
    for (const marker of ['❌', '🗓', '📍', '👤']) expect(safe).toContain(marker);
    expect(safe).toContain('2026-09-15 10:00 – 11:30 (W. Europe Standard Time)');
    expect(safe).toContain('href="https://teams.microsoft.com/l/meetup-join/abc?x=1&amp;y=2"');
  });
});
