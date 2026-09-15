import { describe, expect, it } from 'vitest';
import {
  parseAuthResults,
  extractAuthResultHeaders,
  extractAuthservId,
  extractAuthservIds,
  normalizeAuthservId,
  hasTrustedAuthResults,
} from './spamParser.js';

describe('extractAuthResultHeaders', () => {
  it('handles an array of raw header lines (with or without label)', () => {
    const lines = [
      'Received: from mx.example.com',
      'Authentication-Results: mx.google.com; dkim=pass header.i=@example.com',
    ];
    const payloads = extractAuthResultHeaders(lines);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain('dkim=pass');
  });

  it('unfolds folded headers', () => {
    const lines = [
      'Authentication-Results: mx.google.com;',
      '  dkim=pass header.i=@example.com;',
      '  spf=pass smtp.mailfrom=example.com',
    ];
    const payloads = extractAuthResultHeaders(lines);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain('dkim=pass');
    expect(payloads[0]).toContain('spf=pass');
  });

  it('handles a lowercase header-name object map', () => {
    const headers = {
      'authentication-results': 'mx.google.com; dkim=pass header.i=@example.com',
    };
    expect(extractAuthResultHeaders(headers)).toHaveLength(1);
  });

  it('returns [] when no Authentication-Results header exists', () => {
    expect(extractAuthResultHeaders(['Subject: hi'])).toEqual([]);
    expect(extractAuthResultHeaders({})).toEqual([]);
  });
});

describe('parseAuthResults — RFC 7601 examples (trusted authserv-id)', () => {
  it('parses a full Gmail-style header: all pass', () => {
    const headers = [
      'Authentication-Results: mx.google.com;',
      ' dkim=pass header.i=@example.com header.s=sel header.b=abc;',
      ' spf=pass (google.com: domain of sender@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=sender@example.com;',
      ' dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
    ];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.google.com' }))
      .toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
  });

  it('parses a header with a single method only', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=fail header.d=example.com'];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: 'fail', spf: null, dmarc: null });
  });

  it('treats best_guess_pass as pass', () => {
    const headers = ['Authentication-Results: mx.example.com; spf=best_guess_pass smtp.mailfrom=example.com'];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }).spf).toBe('pass');
  });

  it('keeps the first non-pass value per method', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=neutral; dkim=pass header.d=other.com'];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }).dkim).toBe('pass');
  });

  it('returns nulls when the header is absent', () => {
    expect(parseAuthResults(['Subject: hi'], { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: null, spf: null, dmarc: null });
  });

  it('merges multiple headers from the same trusted authserv-id (relay chain)', () => {
    const headers = [
      'Authentication-Results: mx.example.com; spf=fail smtp.mailfrom=spoof.com',
      'Authentication-Results: mx.example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
    ];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: 'pass', spf: 'fail', dmarc: 'pass' });
  });

  it('ignores malformed segments and unknown methods', () => {
    const headers = [
      'Authentication-Results: mx.example.com; weird-format; arc=pass i=1; dkim=permerror header.d=example.com',
    ];
    const result = parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' });
    expect(result.dkim).toBe('permerror');
    expect(result.spf).toBeNull();
  });

  it('parses a Gmail/Outlook mixed failure case', () => {
    const headers = [
      'Authentication-Results: mx.google.com;',
      ' dkim=fail header.i=@spoofed.com header.s=sel header.b=zzz;',
      ' spf=softfail (google.com: domain of transitioning user@spoofed.com does not designate 5.6.7.8 as permitted sender) smtp.mailfrom=user@spoofed.com;',
      ' dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=spoofed.com',
    ];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.google.com' }))
      .toEqual({ dkim: 'fail', spf: 'softfail', dmarc: 'fail' });
  });

  it('handles values in any case', () => {
    const headers = ['Authentication-Results: mx.example.com; DKIM=PASS header.d=example.com; SPF=PASS'];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: 'pass', spf: 'pass', dmarc: null });
  });

  it('accepts the authserv-id as an array and tolerates extra whitespace', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=pass header.d=example.com'];
    expect(parseAuthResults(headers, { trustedAuthservIds: [' other.example.org ', 'MX.Example.COM'] }).dkim)
      .toBe('pass');
  });
});

describe('authserv-id extraction', () => {
  it('takes the first token of the payload', () => {
    expect(extractAuthservId('mx.google.com; dkim=pass')).toBe('mx.google.com');
    expect(extractAuthservId('  MX.Example.ORG ; spf=pass')).toBe('mx.example.org');
  });

  it('drops the optional authserv-id-version', () => {
    expect(extractAuthservId('mx.google.com 1; dkim=pass')).toBe('mx.google.com');
    expect(extractAuthservId('example.com/2; dkim=pass')).toBe('example.com');
  });

  it('skips parenthesised comments before the id', () => {
    expect(extractAuthservId('(unknown) mx.example.org; dkim=pass')).toBe('mx.example.org');
  });

  it('returns null for a payload without an authserv-id', () => {
    expect(extractAuthservId('')).toBeNull();
    expect(extractAuthservId('; dkim=pass')).toBeNull();
  });

  it('lists every distinct id in header order', () => {
    const headers = [
      'Authentication-Results: mx.example.com; dkim=fail',
      'Authentication-Results: attacker.invalid; dkim=pass',
      'Authentication-Results: MX.Example.com; spf=fail',
    ];
    expect(extractAuthservIds(headers)).toEqual(['mx.example.com', 'attacker.invalid']);
    expect(extractAuthservIds(['Subject: hi'])).toEqual([]);
  });

  it('normalizes a configured value', () => {
    expect(normalizeAuthservId('  MX.Example.COM/2 ')).toBe('mx.example.com');
    expect(normalizeAuthservId('')).toBeNull();
    expect(normalizeAuthservId(undefined)).toBeNull();
  });
});

describe('authserv-id trust gate', () => {
  // A sender can add their own Authentication-Results to the message. Because
  // RFC 7601 permits multiple such headers and 'pass' wins across them, an
  // untrusted header must never be honored.
  const forgedPass = 'Authentication-Results: attacker.invalid; dkim=pass; spf=pass; dmarc=pass';
  const realFail = 'Authentication-Results: mx.example.com; dkim=fail header.d=spoof.com';

  it('ignores a forged pass and honors the trusted fail', () => {
    const result = parseAuthResults([forgedPass, realFail], { trustedAuthservIds: 'mx.example.com' });
    expect(result).toEqual({ dkim: 'fail', spf: null, dmarc: null });
  });

  it('honors nothing when no authserv-id is configured', () => {
    expect(parseAuthResults([forgedPass], {})).toEqual({ dkim: null, spf: null, dmarc: null });
    expect(parseAuthResults([forgedPass])).toEqual({ dkim: null, spf: null, dmarc: null });
    expect(parseAuthResults([forgedPass], { trustedAuthservIds: '' }))
      .toEqual({ dkim: null, spf: null, dmarc: null });
  });

  it('honors nothing when only untrusted headers are present', () => {
    expect(parseAuthResults([forgedPass], { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: null, spf: null, dmarc: null });
  });

  it('hasTrustedAuthResults reflects the gate', () => {
    expect(hasTrustedAuthResults([forgedPass], 'mx.example.com')).toBe(false);
    expect(hasTrustedAuthResults([forgedPass, realFail], 'mx.example.com')).toBe(true);
    expect(hasTrustedAuthResults([realFail])).toBe(false);
    expect(hasTrustedAuthResults(['Subject: hi'], 'mx.example.com')).toBe(false);
    expect(hasTrustedAuthResults([], 'mx.example.com')).toBe(false);
  });

  it('does not match a partial authserv-id', () => {
    const headers = ['Authentication-Results: mx.example.com.evil.test; dkim=pass'];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }).dkim).toBeNull();
  });

  it('works with the header-object shape produced by the IMAP parser', () => {
    const headers = { 'authentication-results': [forgedPass, realFail] };
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }).dkim).toBe('fail');
    expect(hasTrustedAuthResults(headers, 'mx.example.com')).toBe(true);
  });

  it('splits repeated headers joined with newlines (messageParser shape)', () => {
    // messageParser.parseHeadersInput joins repeated instances with '\n' under
    // one lowercase key — each line must keep its own authserv-id.
    const headers = {
      'authentication-results': 'mx.example.com; dkim=fail header.d=spoof.com\nattacker.invalid; dkim=pass; spf=pass',
    };
    expect(extractAuthservIds(headers)).toEqual(['mx.example.com', 'attacker.invalid']);
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: 'fail', spf: null, dmarc: null });
  });

  it('unfolds a folded continuation inside a joined map value', () => {
    const headers = {
      'authentication-results': 'mx.example.com;\n dkim=pass header.d=example.com;\n spf=pass smtp.mailfrom=example.com',
    };
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }))
      .toEqual({ dkim: 'pass', spf: 'pass', dmarc: null });
  });
});
