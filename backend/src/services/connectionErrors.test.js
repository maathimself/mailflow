import { describe, expect, it } from 'vitest';
import { sanitizeConnectionError } from './connectionErrors.js';

describe('sanitizeConnectionError', () => {
  const fixtures = [
    {
      error: new Error('connect ECONNREFUSED 203.0.113.1:587'),
      expectedMessage: 'Could not connect to the mail server. Check your SMTP settings.',
    },
    {
      error: new Error('535 5.7.8 Authentication failed: invalid login'),
      expectedMessage: 'Authentication failed. Check your email account credentials.',
    },
    {
      error: new Error('454 4.7.94 rate limit exceeded'),
      expectedMessage: 'The mail server is rate limiting sends. Please try again shortly.',
    },
    {
      error: new Error('550 5.1.1 rejected as spam'),
      expectedMessage: 'Message was rejected by the mail server.',
    },
    {
      error: new Error('TLS certificate handshake failed'),
      expectedMessage: 'Secure connection to the mail server failed. Check your TLS settings.',
    },
    {
      error: new Error('unexpected SMTP response'),
      expectedMessage: 'Failed to send message. Please try again.',
    },
    {
      error: { authenticationFailed: true, message: 'Command failed' },
      expectedMessage: 'Authentication failed. Check your email account credentials.',
    },
    {
      error: { code: 'AUTHENTICATIONFAILED', responseStatus: 'NO', message: 'NO Login denied' },
      expectedMessage: 'Authentication failed. Check your email account credentials.',
    },
    {
      error: { responseStatus: 'BAD', message: 'BAD invalid command during connection' },
      expectedMessage: 'The IMAP server rejected the connection. Check your IMAP settings.',
    },
    {
      error: new Error('Failed to receive greeting from server'),
      expectedMessage: 'Could not establish an IMAP connection. Check your IMAP settings.',
    },
    {
      error: new Error('Server did not advertise IMAP4rev1 capability'),
      expectedMessage: 'Could not establish an IMAP connection. Check your IMAP settings.',
    },
    {
      error: new Error('Connection test timed out after 10 seconds'),
      expectedMessage: 'Connection test timed out. Check your mail server settings.',
    },
    {
      error: { responseStatus: 'NO', message: 'NO mailbox unavailable' },
      expectedMessage: 'The IMAP server rejected the connection. Check your IMAP settings.',
    },
  ];

  it.each(fixtures)('maps $error to a safe message', ({ error, expectedMessage }) => {
    expect(sanitizeConnectionError(error)).toBe(expectedMessage);
  });
});
