import { describe, expect, it } from 'vitest';
import {
  cleanText,
  tokenize,
  normalizeToken,
  extractFlagFeatures,
  tokenFingerprint,
  EXECUTABLE_EXTENSIONS,
} from './spamTokenizer.js';

describe('cleanText', () => {
  it('strips HTML tags and collapses whitespace', () => {
    expect(cleanText('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('drops script/style/head content', () => {
    const html =
      '<html><head><style>p{color:red}</style></head>' +
      '<script>alert(1)</script><body>Visible body</body></html>';
    expect(cleanText(html)).toBe('Visible body');
  });

  it('decodes HTML entities on the plain path', () => {
    expect(cleanText('Tom &amp; Jerry &nbsp; --')).toBe('Tom & Jerry --');
  });

  it('returns empty for empty/whitespace input', () => {
    expect(cleanText('')).toBe('');
    expect(cleanText('   \n  ')).toBe('');
  });
});

describe('normalizeToken', () => {
  it('lowercases', () => {
    expect(normalizeToken('SPAM')).toBe('spam');
  });

  it('drops stop-words', () => {
    expect(normalizeToken('the')).toBeNull();
    expect(normalizeToken('il')).toBeNull();
    expect(normalizeToken('и')).toBeNull();
  });

  it('drops pure-numeric tokens', () => {
    expect(normalizeToken('12345')).toBeNull();
    expect(normalizeToken('2024')).toBeNull();
  });

  it('enforces min length 2 and max length 30', () => {
    expect(normalizeToken('a')).toBeNull();
    expect(normalizeToken('x'.repeat(31))).toBeNull();
    expect(normalizeToken('ab')).toBe('ab');
  });

  it('keeps spam-discriminative words', () => {
    expect(normalizeToken('viagra')).toBe('viagra');
    expect(normalizeToken('click')).toBe('click');
  });

  it('segments CJK runs into single ideographs', () => {
    expect(normalizeToken('药店')).toBe('药'); // '药店' split
  });
});

describe('tokenize', () => {
  it('tokenizes subject + body, weighting subject by duplication', () => {
    const tokens = tokenize({
      subject: 'free money',
      body: 'click here for viagra',
    });
    // subject appears twice (x2 weight), body once
    expect(tokens.filter(t => t === 'free').length).toBe(2);
    expect(tokens.filter(t => t === 'money').length).toBe(2);
    expect(tokens.filter(t => t === 'click').length).toBe(1);
    expect(tokens.filter(t => t === 'viagra').length).toBe(1);
  });

  it('returns empty when the subject is only emoji/stop-words', () => {
    expect(tokenize({ subject: '🎉🎉 the and of for', body: '' }).length).toBe(0);
  });

  it('strips HTML from the body', () => {
    const tokens = tokenize({ subject: 'sale', body: '<a href="#">buy now</a>' });
    expect(tokens.filter(t => t === 'buy').length).toBe(1);
  });

  it('handles Cyrillic tokens', () => {
    const tokens = tokenize({ subject: 'виагра', body: '' });
    expect(tokens).toContain('виагра');
  });

  it('extracts URL-host tokens separately', () => {
    const tokens = tokenize({ subject: 'offer', body: 'visit https://bit.ly/x now' });
    expect(tokens).toContain('bit.ly');
  });

  it('when body is missing falls back to bodyHtml', () => {
    const tokens = tokenize({ subject: 'note', bodyHtml: '<p>urgent invoice</p>' });
    expect(tokens).toContain('urgent');
    expect(tokens).toContain('invoice');
  });
});

describe('extractFlagFeatures', () => {
  it('computes auth flags with null when header absent', () => {
    const flags = extractFlagFeatures({ subject: 'hi', headers: [] });
    expect(flags.dkim_pass).toBeNull();
    expect(flags.spf_pass).toBeNull();
    expect(flags.dmarc_pass).toBeNull();
  });

  it('sets dkim_pass=1 on pass, 0 on fail', () => {
    const pass = extractFlagFeatures({
      subject: 'hi',
      headers: ['Authentication-Results: mx.com; dkim=pass header.d=x.com'],
    });
    expect(pass.dkim_pass).toBe(1);
    const fail = extractFlagFeatures({
      subject: 'hi',
      headers: ['Authentication-Results: mx.com; dkim=fail header.d=x.com'],
    });
    expect(fail.dkim_pass).toBe(0);
  });

  it('detects executable attachments', () => {
    const flags = extractFlagFeatures({
      subject: 'hi',
      attachments: [{ filename: 'invoice.pdf.exe' }],
    });
    expect(flags.has_attachment).toBe(1);
    expect(flags.attachment_is_executable).toBe(1);
  });

  it('ignores non-executable attachments', () => {
    const flags = extractFlagFeatures({
      subject: 'hi',
      attachments: [{ filename: 'invoice.pdf' }],
    });
    expect(flags.attachment_is_executable).toBe(0);
  });

  it('computes all_caps_subject_ratio', () => {
    expect(extractFlagFeatures({ subject: 'HELLO' }).all_caps_subject_ratio).toBe(1);
    expect(extractFlagFeatures({ subject: 'Hello' }).all_caps_subject_ratio).toBe(1 / 5);
    expect(extractFlagFeatures({ subject: '123' }).all_caps_subject_ratio).toBe(0);
  });

  it('detects from/reply-to domain mismatch', () => {
    const mismatch = extractFlagFeatures({
      subject: 'hi',
      from: 'sender@example.com',
      replyTo: 'other@spoof.net',
    });
    expect(mismatch.from_equals_reply_to_mismatch).toBe(1);
    const match = extractFlagFeatures({
      subject: 'hi',
      from: 'sender@example.com',
      replyTo: 'reply@example.com',
    });
    expect(match.from_equals_reply_to_mismatch).toBe(0);
  });
});

describe('tokenFingerprint', () => {
  it('is deterministic for identical messages', () => {
    const a = { subject: 'hi', body: 'world' };
    expect(tokenFingerprint(a)).toBe(tokenFingerprint({ ...a }));
  });

  it('changes when the content changes', () => {
    expect(tokenFingerprint({ subject: 'hi', body: 'world' })).not.toBe(
      tokenFingerprint({ subject: 'hi', body: 'different' }),
    );
  });

  it('yields a 64-char hex digest', () => {
    expect(tokenFingerprint({ subject: 'hi' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('EXECUTABLE_EXTENSIONS', () => {
  it('covers common executable extensions', () => {
    for (const ext of ['exe', 'scr', 'js', 'vbs', 'bat', 'cmd', 'jar', 'sh', 'ps1']) {
      expect(EXECUTABLE_EXTENSIONS.has(ext), `${ext} should be executable`).toBe(true);
    }
  });
});