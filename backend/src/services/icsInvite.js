// Display-only rendering of calendar-only messages (text/calendar with no
// text/html or text/plain alternative, e.g. Outlook "Forward meeting" or some
// Exchange/Teams notifications). Without this the reader showed raw VCALENDAR.
//
// The rendered body is cached server-side per message and shared by every user
// regardless of UI language, so the card is language-neutral: icons instead of
// words. No RSVP, no timezone conversion (times are shown as written with their
// TZID label). Every value from the ICS is attacker-controlled and is escaped
// here; the resulting HTML still goes through sanitizeEmail() like any body.

const MARKER_CANCEL = '❌';
const MARKER_REPLY = '↩';
const ICON_TIME = '🗓';
const ICON_LOCATION = '📍';
const ICON_ORGANIZER = '👤';

const CARD_STYLE = 'border:1px solid #d0d7de;border-radius:8px;padding:12px 16px;margin:0 0 16px 0;'
  + 'max-width:640px;background-color:#f6f8fa;color:#1f2328;'
  + 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5';
const TITLE_STYLE = 'font-size:18px;font-weight:bold;margin:0 0 8px 0';
const ROW_STYLE = 'margin:2px 0';
const DESCRIPTION_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5';

// RFC 5545 3.1: a line break followed by a single space or tab continues the
// previous content line.
export function unfoldIcs(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}

// RFC 5545 3.3.11 TEXT escapes. One pass so an escaped backslash followed by
// "n" stays a literal backslash + n.
export function unescapeIcsText(value) {
  return String(value || '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function splitOutsideQuotes(str, sep) {
  const out = [];
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === sep && !inQuote) {
      out.push(str.slice(start, i));
      start = i + 1;
    }
  }
  out.push(str.slice(start));
  return out;
}

// NAME;PARAM=VALUE;PARAM="quoted:value":property value
function parseContentLine(line) {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) { colon = i; break; }
  }
  if (colon <= 0) return null;
  const [rawName, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params = {};
  for (const raw of rawParams) {
    const eq = raw.indexOf('=');
    if (eq <= 0) continue;
    let v = raw.slice(eq + 1);
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[raw.slice(0, eq).trim().toUpperCase()] = v;
  }
  return { name: rawName.trim().toUpperCase(), params, value: line.slice(colon + 1) };
}

const EVENT_PROPS = new Set(['SUMMARY', 'DTSTART', 'DTEND', 'LOCATION', 'ORGANIZER', 'DESCRIPTION', 'X-ALT-DESC']);

// Returns the METHOD and the properties of the first VEVENT, or null when the
// input has no VEVENT. Properties of nested components (VALARM) and of other
// top-level components (VTIMEZONE) are ignored.
export function parseFirstVevent(text) {
  const stack = [];
  let method = null;
  let props = null;
  let eventLevel = 0;
  let eventDone = false;

  for (const line of unfoldIcs(text).split(/\r?\n/)) {
    const p = parseContentLine(line);
    if (!p) continue;
    const upperValue = p.value.trim().toUpperCase();
    if (p.name === 'BEGIN') {
      stack.push(upperValue);
      if (!props && upperValue === 'VEVENT') {
        props = {};
        eventLevel = stack.length;
      }
    } else if (p.name === 'END') {
      if (props && !eventDone && stack.length === eventLevel && upperValue === 'VEVENT') eventDone = true;
      stack.pop();
    } else if (props && !eventDone && stack.length === eventLevel) {
      if (EVENT_PROPS.has(p.name) && !(p.name in props)) props[p.name] = p;
    } else if (stack.length === 1 && stack[0] === 'VCALENDAR' && p.name === 'METHOD' && !method) {
      method = upperValue;
    }
  }
  if (!props) return null;

  const dateProp = (prop) => (prop ? {
    value: prop.value.trim(),
    tzid: prop.params.TZID || null,
    isDate: (prop.params.VALUE || '').toUpperCase() === 'DATE',
  } : null);

  let organizer = null;
  if (props.ORGANIZER) {
    const email = props.ORGANIZER.value.trim().replace(/^mailto:/i, '');
    const name = (props.ORGANIZER.params.CN || '').trim();
    organizer = { name: name || null, email: email || null };
  }

  const altDesc = props['X-ALT-DESC'];
  return {
    method,
    summary: props.SUMMARY ? unescapeIcsText(props.SUMMARY.value).trim() : null,
    location: props.LOCATION ? unescapeIcsText(props.LOCATION.value).trim() : null,
    description: props.DESCRIPTION ? unescapeIcsText(props.DESCRIPTION.value).trim() : null,
    altDescHtml: altDesc && (altDesc.params.FMTTYPE || '').toLowerCase() === 'text/html'
      ? unescapeIcsText(altDesc.value).trim()
      : null,
    organizer,
    dtstart: dateProp(props.DTSTART),
    dtend: dateProp(props.DTEND),
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// DATE (YYYYMMDD) or DATE-TIME (YYYYMMDDTHHMMSS[Z]) as written. Returns null for
// anything else so the caller can show the raw value.
function parseIcsDate(prop) {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(prop.value);
  if (d) return { allDay: true, date: `${d[1]}-${d[2]}-${d[3]}` };
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(prop.value);
  if (!t) return null;
  return {
    allDay: prop.isDate,
    date: `${t[1]}-${t[2]}-${t[3]}`,
    time: t[6] === '00' ? `${t[4]}:${t[5]}` : `${t[4]}:${t[5]}:${t[6]}`,
    label: t[7] ? 'UTC' : prop.tzid,
  };
}

// An all-day DTEND is exclusive (RFC 5545 3.6.1): the last day is the day before.
// Returns null for an impossible date such as 20261399.
function previousDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function withLabel(s, label) {
  return label ? `${s} (${label})` : s;
}

function formatWhen(dtstart, dtend) {
  if (!dtstart) return null;
  const start = parseIcsDate(dtstart);
  if (!start) return withLabel(dtstart.value, dtstart.tzid);
  const end = dtend ? parseIcsDate(dtend) : null;

  if (start.allDay) {
    if (!end) return start.date;
    const last = previousDay(end.date);
    return last && last > start.date ? `${start.date} – ${last}` : start.date;
  }

  const startStr = `${start.date} ${start.time}`;
  if (!end || end.allDay) return withLabel(startStr, start.label);
  const endStr = end.date === start.date ? end.time : `${end.date} ${end.time}`;
  if (end.label === start.label) return withLabel(`${startStr} – ${endStr}`, start.label);
  return `${withLabel(startStr, start.label)} – ${withLabel(endStr, end.label)}`;
}

function formatOrganizer(org) {
  if (!org || (!org.name && !org.email)) return null;
  if (org.name && org.email) return `${org.name} <${org.email}>`;
  return org.name || org.email;
}

const URL_RE = /https?:\/\/[^\s<>"]+/g;

// Escape plain text, keep line breaks, and turn bare http(s) URLs into links
// (Teams/Zoom join links are usually only present in the description).
function plainToHtml(text) {
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    while (url.length && '.,;:!?)\''.includes(url[url.length - 1])) url = url.slice(0, -1);
    out += escapeHtml(text.slice(pos, m.index));
    out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    pos = m.index + url.length;
  }
  out += escapeHtml(text.slice(pos));
  return out.replace(/\r?\n/g, '<br>');
}

// Exchange/Outlook put a whole HTML document into X-ALT-DESC. A DOCTYPE or
// <html>/<head> nested inside the card makes sanitizeEmail drop everything after
// it, so keep only the body content. Returns null when nothing visible remains,
// letting the caller fall back to the plain DESCRIPTION.
function extractAltDescBody(html) {
  const lower = html.toLowerCase();
  const bodyOpen = lower.indexOf('<body');
  let body;
  if (bodyOpen !== -1) {
    const contentStart = lower.indexOf('>', bodyOpen);
    const bodyClose = lower.lastIndexOf('</body');
    body = contentStart === -1
      ? ''
      : html.slice(contentStart + 1, bodyClose > contentStart ? bodyClose : undefined);
  } else {
    body = rewriteTags(html, (tag) => (DOCUMENT_WRAPPER_TAG_RE.test(tag) ? '' : tag));
  }
  body = body.trim();
  let hasLink = false;
  const visibleText = rewriteTags(body, (tag) => {
    if (/^<a\s/i.test(tag) && tag.toLowerCase().includes('href=')) hasLink = true;
    return '';
  }).replace(/&nbsp;/gi, ' ').trim();
  return visibleText || hasLink ? body : null;
}

const DOCUMENT_WRAPPER_TAG_RE = /^<\/?(?:!doctype|html|head|meta|title)\b/i;

// Replaces every `<...>` tag with mapTag(tag) in a single left-to-right pass.
// indexOf-based on purpose: regex tag matching on sender-controlled HTML can
// backtrack quadratically. Text after an unterminated `<` is kept as is.
function rewriteTags(html, mapTag) {
  let out = '';
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    const gt = lt === -1 ? -1 : html.indexOf('>', lt + 1);
    if (gt === -1) {
      out += html.slice(pos);
      break;
    }
    out += html.slice(pos, lt) + mapTag(html.slice(lt, gt + 1));
    pos = gt + 1;
  }
  return out;
}

// Returns { html, text } for the first VEVENT of an ICS payload, or null when
// the payload has no VEVENT (the caller then keeps the raw text).
export function renderInviteHtml(ics) {
  const ev = parseFirstVevent(ics);
  if (!ev) return null;

  const cancelled = ev.method === 'CANCEL';
  const marker = cancelled ? MARKER_CANCEL : ev.method === 'REPLY' ? MARKER_REPLY : null;
  const when = formatWhen(ev.dtstart, ev.dtend);
  const organizer = formatOrganizer(ev.organizer);

  const htmlRows = [];
  const textLines = [];

  if (marker || ev.summary) {
    const title = ev.summary ? (cancelled ? `<s>${escapeHtml(ev.summary)}</s>` : escapeHtml(ev.summary)) : '';
    htmlRows.push(`<div style="${TITLE_STYLE}">${[marker, title].filter(Boolean).join(' ')}</div>`);
    textLines.push([marker, ev.summary].filter(Boolean).join(' '));
  }
  for (const [icon, value] of [[ICON_TIME, when], [ICON_LOCATION, ev.location], [ICON_ORGANIZER, organizer]]) {
    if (!value) continue;
    htmlRows.push(`<div style="${ROW_STYLE}">${icon} ${escapeHtml(value)}</div>`);
    textLines.push(`${icon} ${value}`);
  }
  // Nothing displayable: let the caller keep the raw text rather than show an empty card.
  const altDescBody = ev.altDescHtml ? extractAltDescBody(ev.altDescHtml) : null;
  if (!htmlRows.length && !ev.description && !altDescBody) return null;

  let html = `<div style="${CARD_STYLE}">${htmlRows.join('')}</div>`;
  if (altDescBody) html += `<div style="${DESCRIPTION_STYLE}">${altDescBody}</div>`;
  else if (ev.description) html += `<div style="${DESCRIPTION_STYLE}">${plainToHtml(ev.description)}</div>`;

  if (ev.description) textLines.push('', ev.description);

  return { html, text: textLines.join('\n') };
}
