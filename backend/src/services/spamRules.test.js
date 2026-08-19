import { describe, expect, it } from 'vitest';
import { scoreRules, explainRules, normalizeContactAddress, RULES } from './spamRules.js';

// Minimal email-shaped objects for rule tests.
const baseEmail = {
  subject: 'Hello',
  body: 'Just a normal message.',
  from: 'friend@example.com',
  headers: [],
};

describe('rules table integrity', () => {
  it('exports exactly 14 rules', () => {
    expect(RULES).toHaveLength(14);
  });

  it('weights match the approved rules-detail doc', () => {
    const byName = Object.fromEntries(RULES.map(r => [r.name, r.weight]));
    expect(byName.SUBJECT_ALL_CAPS).toBe(0.3);
    expect(byName.SUBJECT_MANY_EXCLAMATIONS).toBe(0.2);
    expect(byName.SUBJECT_PHARMA_KEYWORDS).toBe(0.5);
    expect(byName.SUBJECT_MONEY_KEYWORDS).toBe(0.4);
    expect(byName.BODY_SPAM_KEYWORDS).toBe(0.4);
    expect(byName.BODY_URL_SHORTENER).toBe(0.3);
    expect(byName.FROM_REPLYTO_MISMATCH).toBe(0.4);
    expect(byName.ATTACHMENT_EXECUTABLE).toBe(0.6);
    expect(byName.ATTACHMENT_DOUBLE_EXT).toBe(0.3);
    expect(byName.AUTH_DKIM_FAIL).toBe(0.4);
    expect(byName.AUTH_SPF_FAIL).toBe(0.4);
    expect(byName.AUTH_DMARC_FAIL).toBe(0.4);
    expect(byName.MAILING_LIST_HEADERS).toBe(-0.2);
    expect(byName.FROM_IN_USER_CONTACTS).toBe(-0.5);
  });
});

describe('scoreRules — individual rules', () => {
  it('SUBJECT_ALL_CAPS fires on >50% uppercase subject', () => {
    const { score, fired } = scoreRules({ ...baseEmail, subject: 'URGENT MEETING REMINDER' });
    expect(fired.some(r => r.name === 'SUBJECT_ALL_CAPS')).toBe(true);
    expect(score).toBeCloseTo(0.3);
  });

  it('SUBJECT_MANY_EXCLAMATIONS fires on 4+ exclamations', () => {
    const { fired } = scoreRules({ ...baseEmail, subject: 'WOW!!!!' });
    expect(fired.some(r => r.name === 'SUBJECT_MANY_EXCLAMATIONS')).toBe(true);
  });

  it('SUBJECT_PHARMA_KEYWORDS fires on viagra in subject', () => {
    const { score, fired } = scoreRules({ ...baseEmail, subject: 'Cheap VIAGRA for you' });
    expect(fired.some(r => r.name === 'SUBJECT_PHARMA_KEYWORDS')).toBe(true);
    expect(score).toBe(0.5);
  });

  it('SUBJECT_MONEY_KEYWORDS fires on lottery phrases', () => {
    const { fired } = scoreRules({ ...baseEmail, subject: 'You have won the lottery!' });
    expect(fired.some(r => r.name === 'SUBJECT_MONEY_KEYWORDS')).toBe(true);
  });

  it('BODY_SPAM_KEYWORDS requires 2+ unique phrases', () => {
    const one = scoreRules({ ...baseEmail, body: 'Please click here to view.' });
    expect(one.fired.some(r => r.name === 'BODY_SPAM_KEYWORDS')).toBe(false);
    const two = scoreRules({
      ...baseEmail,
      body: 'Click here now. Limited time offer, act now!',
    });
    expect(two.fired.some(r => r.name === 'BODY_SPAM_KEYWORDS')).toBe(true);
  });

  it('BODY_URL_SHORTENER fires on bit.ly links', () => {
    const { fired } = scoreRules({ ...baseEmail, body: 'See https://bit.ly/abc123' });
    expect(fired.some(r => r.name === 'BODY_URL_SHORTENER')).toBe(true);
  });

  it('FROM_REPLYTO_MISMATCH fires on differing registrable domains', () => {
    const { fired } = scoreRules({
      ...baseEmail,
      from: 'sender@example.com',
      replyTo: 'reply@spoof.net',
    });
    expect(fired.some(r => r.name === 'FROM_REPLYTO_MISMATCH')).toBe(true);
  });

  it('FROM_REPLYTO_MISMATCH does not fire when Reply-To is absent', () => {
    const { fired } = scoreRules({ ...baseEmail, from: 'a@example.com' });
    expect(fired.some(r => r.name === 'FROM_REPLYTO_MISMATCH')).toBe(false);
  });

  it('FROM_REPLYTO_MISMATCH compares registrable domains (mail.brand.com ≡ brand.com)', () => {
    const { fired } = scoreRules({
      ...baseEmail,
      from: 'a@mail.brand.com',
      replyTo: 'b@brand.com',
    });
    expect(fired.some(r => r.name === 'FROM_REPLYTO_MISMATCH')).toBe(false);
  });

  it('ATTACHMENT_EXECUTABLE fires on .exe attachment', () => {
    const { score, fired } = scoreRules({
      ...baseEmail,
      attachments: [{ filename: 'invoice.exe' }],
    });
    expect(fired.some(r => r.name === 'ATTACHMENT_EXECUTABLE')).toBe(true);
    expect(score).toBe(0.6);
  });

  it('ATTACHMENT_DOUBLE_EXT fires on invoice.pdf.exe', () => {
    const { fired } = scoreRules({
      ...baseEmail,
      attachments: [{ filename: 'invoice.pdf.exe' }],
    });
    expect(fired.some(r => r.name === 'ATTACHMENT_DOUBLE_EXT')).toBe(true);
  });

  it('deduplicates attachment rules in the score (max, not sum)', () => {
    const { score, fired } = scoreRules({
      ...baseEmail,
      attachments: [{ filename: 'invoice.pdf.exe' }],
    });
    // Both rules fire and are reported for explainability, but the score
    // counts the max (0.6) once: 0.6, not 0.9.
    expect(fired.some(r => r.name === 'ATTACHMENT_EXECUTABLE')).toBe(true);
    expect(fired.some(r => r.name === 'ATTACHMENT_DOUBLE_EXT')).toBe(true);
    expect(score).toBe(0.6);
  });

  it('AUTH_DKIM_FAIL fires on dkim=fail', () => {
    const { fired } = scoreRules({
      ...baseEmail,
      headers: ['Authentication-Results: mx.com; dkim=fail header.d=x.com'],
    });
    expect(fired.some(r => r.name === 'AUTH_DKIM_FAIL')).toBe(true);
  });

  it('AUTH_SPF_FAIL does not fire on spf=neutral', () => {
    const { fired } = scoreRules({
      ...baseEmail,
      headers: ['Authentication-Results: mx.com; spf=neutral smtp.mailfrom=x.com'],
    });
    expect(fired.some(r => r.name === 'AUTH_SPF_FAIL')).toBe(false);
  });

  it('MAILING_LIST_HEADERS fires with List-Id + List-Unsubscribe', () => {
    const { fired } = scoreRules({
      ...baseEmail,
      headers: [
        'List-Id: <newsletter.example.com>',
        'List-Unsubscribe: <mailto:unsub@example.com>',
      ],
    });
    expect(fired.some(r => r.name === 'MAILING_LIST_HEADERS')).toBe(true);
  });

  it('FROM_IN_USER_CONTACTS fires when sender is a known contact', () => {
    const contacts = new Set(['friend@example.com']);
    const { fired } = scoreRules(baseEmail, { userContacts: contacts });
    expect(fired.some(r => r.name === 'FROM_IN_USER_CONTACTS')).toBe(true);
  });

  it('FROM_IN_USER_CONTACTS normalizes Gmail local parts', () => {
    const contacts = new Set(['johndoe@gmail.com']);
    const { fired } = scoreRules(
      { ...baseEmail, from: 'john.doe+spam@gmail.com' },
      { userContacts: contacts },
    );
    expect(fired.some(r => r.name === 'FROM_IN_USER_CONTACTS')).toBe(true);
  });
});

describe('scoreRules — combined scoring', () => {
  it('returns a score clamped to [0, 1]', () => {
    const worst = scoreRules({
      subject: 'CHEAP VIAGRA!!! WIN $$$',
      body: 'Click here now, limited time offer, buy now, act now',
      from: 'spam@spoof.net',
      replyTo: 'other@evil.com',
      attachments: [{ filename: 'invoice.pdf.exe' }],
      headers: ['Authentication-Results: mx.com; dkim=fail; spf=fail; dmarc=fail'],
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(1);
    expect(worst.score).toBe(1); // several rules stacked clamp at 1
  });

  it('negative rules can keep a normal message at 0', () => {
    const { score } = scoreRules({
      ...baseEmail,
      headers: [
        'List-Id: <list.example.com>',
        'List-Unsubscribe: <mailto:unsub@example.com>',
      ],
    }, { userContacts: new Set(['friend@example.com']) });
    expect(score).toBe(0);
  });
});

describe('explainRules', () => {
  it('reports every rule with fired status', () => {
    const detail = explainRules({ ...baseEmail, subject: 'CHEAP VIAGRA' });
    expect(detail).toHaveLength(14);
    const fired = detail.filter(r => r.fired).map(r => r.name);
    expect(fired).toContain('SUBJECT_PHARMA_KEYWORDS');
    expect(fired).toContain('SUBJECT_ALL_CAPS');
  });
});

describe('normalizeContactAddress', () => {
  it('lowercases and strips display names', () => {
    expect(normalizeContactAddress('"John" <John@Example.com>')).toBe('john@example.com');
  });

  it('strips +tags', () => {
    expect(normalizeContactAddress('john+news@example.com')).toBe('john@example.com');
  });

  it('strips dots only for gmail/googlemail', () => {
    expect(normalizeContactAddress('john.doe@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeContactAddress('john.doe@example.com')).toBe('john.doe@example.com');
  });
});
