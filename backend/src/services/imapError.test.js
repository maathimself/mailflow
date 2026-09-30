import { describe, expect, it } from 'vitest';
import { extractImapError } from './imapError.js';

// The shapes below are what imapflow actually constructs. From imap-flow.js, a rejected
// command builds `new Error('Command failed')` and hangs the detail off it:
//   err.response           the parsed response, whose TEXT attributes carry the reason
//   err.responseStatus     'NO' or 'BAD'
//   err.responseText       those TEXT attributes joined
//   err.serverResponseCode the bracketed code, when the server sends one
// Anything that reads err.message alone gets the string 'Command failed' every time,
// which is the bug this exists to prevent (#474).

const imapflowError = ({ text, code }) => {
  const err = new Error('Command failed');
  err.response = { command: 'NO', attributes: text ? [{ type: 'TEXT', value: text }] : [] };
  err.responseStatus = 'NO';
  if (text) err.responseText = text;
  if (code) err.serverResponseCode = code;
  return err;
};

describe('extractImapError', () => {
  it('returns the reason the server gave, not the generic message', () => {
    const err = imapflowError({ text: 'Too many simultaneous connections' });
    expect(extractImapError(err)).toBe('Too many simultaneous connections');
    expect(extractImapError(err)).not.toBe('Command failed');
  });

  it('prefixes the response code, which is the part worth matching on', () => {
    const err = imapflowError({ text: 'Too many simultaneous connections', code: 'LIMIT' });
    expect(extractImapError(err)).toBe('[LIMIT] Too many simultaneous connections');
  });

  it('reads responseText when the parsed attributes are not populated', () => {
    // Same failure, but reached through a path that left response.attributes empty.
    const err = new Error('Command failed');
    err.responseText = 'Request is throttled. Suspension reason: MaxConcurrency.';
    err.serverResponseCode = 'UNAVAILABLE';
    expect(extractImapError(err)).toBe('[UNAVAILABLE] Request is throttled. Suspension reason: MaxConcurrency.');
  });

  it('falls back to the command and message when the server said nothing', () => {
    const err = new Error('Command failed');
    err.response = { command: 'BAD', attributes: [] };
    expect(extractImapError(err)).toBe('BAD: Command failed');
  });

  it('passes ordinary errors through unchanged', () => {
    expect(extractImapError(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('still reports the code when there is no text at all', () => {
    const err = new Error('Command failed');
    err.serverResponseCode = 'AUTHENTICATIONFAILED';
    expect(extractImapError(err)).toBe('[AUTHENTICATIONFAILED] Command failed');
  });

  // Node's shape for a connect refused on every resolved address (#510): empty message,
  // the aggregate carries a code, and each address has its own error.
  const refusedEverywhere = () => Object.assign(new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED ::1:993'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:993'), { code: 'ECONNREFUSED' }),
  ], ''), { code: 'ECONNREFUSED' });

  it('unwraps an AggregateError into each address\'s reason instead of its empty message', () => {
    expect(String(refusedEverywhere())).toBe('AggregateError');   // what the log used to show
    expect(extractImapError(refusedEverywhere())).toBe('connect ECONNREFUSED ::1:993; connect ECONNREFUSED 127.0.0.1:993');
  });

  it('reports a reason shared by every address once', () => {
    const err = new AggregateError([new Error('connect ETIMEDOUT 10.0.0.1:993'), new Error('connect ETIMEDOUT 10.0.0.1:993')], '');
    expect(extractImapError(err)).toBe('connect ETIMEDOUT 10.0.0.1:993');
  });

  it('falls back to the aggregate code when the per-address errors say nothing', () => {
    const err = Object.assign(new AggregateError([{}, null], ''), { code: 'ECONNREFUSED' });
    expect(extractImapError(err)).toBe('ECONNREFUSED');
  });

  it('never throws on a missing or malformed error', () => {
    expect(extractImapError(null)).toBe('Unknown error');
    expect(extractImapError(undefined)).toBe('Unknown error');
    expect(typeof extractImapError({})).toBe('string');
  });

  it('trims the surrounding whitespace servers pad their text with', () => {
    expect(extractImapError(imapflowError({ text: '  Mailbox does not exist  ' }))).toBe('Mailbox does not exist');
  });
});
