import { describe, expect, it } from 'vitest';
import { parseAuthResults, extractAuthResultHeaders } from './spamParser.js';

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

describe('parseAuthResults — RFC 7601 examples', () => {
  it('parses a full Gmail-style header: all pass', () => {
    const headers = [
      'Authentication-Results: mx.google.com;',
      ' dkim=pass header.i=@example.com header.s=sel header.b=abc;',
      ' spf=pass (google.com: domain of sender@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=sender@example.com;',
      ' dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
    ];
    expect(parseAuthResults(headers)).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
  });

  it('parses a header with a single method only', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=fail header.d=example.com'];
    expect(parseAuthResults(headers)).toEqual({ dkim: 'fail', spf: null, dmarc: null });
  });

  it('treats best_guess_pass as pass', () => {
    const headers = ['Authentication-Results: mx.example.com; spf=best_guess_pass smtp.mailfrom=example.com'];
    expect(parseAuthResults(headers).spf).toBe('pass');
  });

  it('keeps the first non-pass value per method', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=neutral; dkim=pass header.d=other.com'];
    expect(parseAuthResults(headers).dkim).toBe('pass');
  });

  it('returns nulls when the header is absent', () => {
    expect(parseAuthResults(['Subject: hi'])).toEqual({ dkim: null, spf: null, dmarc: null });
  });

  it('handles multiple Authentication-Results headers (e.g. relay chain)', () => {
    const headers = [
      'Authentication-Results: first.example.com; spf=fail smtp.mailfrom=spoof.com',
      'Authentication-Results: final.example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
    ];
    expect(parseAuthResults(headers)).toEqual({ dkim: 'pass', spf: 'fail', dmarc: 'pass' });
  });

  it('ignores malformed segments and unknown methods', () => {
    const headers = [
      'Authentication-Results: mx.example.com; weird-format; arc=pass i=1; dkim=permerror header.d=example.com',
    ];
    const result = parseAuthResults(headers);
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
    expect(parseAuthResults(headers)).toEqual({ dkim: 'fail', spf: 'softfail', dmarc: 'fail' });
  });

  it('handles values in any case', () => {
    const headers = ['Authentication-Results: mx.example.com; DKIM=PASS header.d=example.com; SPF=PASS'];
    expect(parseAuthResults(headers)).toEqual({ dkim: 'pass', spf: 'pass', dmarc: null });
  });
});
