import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { completeText, getAiStatus } from './aiProvider.js';
import { query } from './db.js';
import {
  buildSummaryPrompt,
  sanitizeSummaryLine,
  summarizeAvailable,
  summarizeMessage,
} from './summarize.js';

describe('buildSummaryPrompt', () => {
  it('includes from, subject, and a whitespace-collapsed body', () => {
    const prompt = buildSummaryPrompt({ subject: 'Reports', from: 'Alice', content: 'pulling   the\n\nDeel  reports friday' });
    expect(prompt).toContain('From: Alice');
    expect(prompt).toContain('Subject: Reports');
    expect(prompt).toContain('Body: pulling the Deel reports friday');
    expect(prompt).toMatch(/ONE line of at most 120 characters/);
  });

  it('caps the body length and tolerates missing fields', () => {
    const prompt = buildSummaryPrompt({ content: 'x'.repeat(5000) });
    expect(prompt).toContain('From: (unknown)');
    expect(prompt.length).toBeLessThan(1400); // 1000-char body cap
  });

  it('honours a custom maxLen', () => {
    expect(buildSummaryPrompt({ maxLen: 60 })).toMatch(/ONE line of at most 60 characters/);
  });
});

describe('sanitizeSummaryLine', () => {
  it('takes the first non-empty line and trims', () => {
    expect(sanitizeSummaryLine('\n  pulling the Deel reports friday  \nextra')).toBe('pulling the Deel reports friday');
  });

  it('strips wrapping quotes and emoji', () => {
    expect(sanitizeSummaryLine('"waiting on their reply 🎉"')).toBe('waiting on their reply');
    expect(sanitizeSummaryLine('“sending the invoice ❤️ next week”')).toBe('sending the invoice next week');
  });

  it('collapses whitespace and hard-caps at 120 chars by default', () => {
    const out = sanitizeSummaryLine('a '.repeat(200));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toMatch(/\s{2,}/);
  });

  it('respects a custom maxLen cap', () => {
    expect(sanitizeSummaryLine('a '.repeat(200), 40).length).toBeLessThanOrEqual(40);
  });

  it('returns null for empty or non-string input', () => {
    expect(sanitizeSummaryLine('')).toBeNull();
    expect(sanitizeSummaryLine('   ')).toBeNull();
    expect(sanitizeSummaryLine(null)).toBeNull();
    expect(sanitizeSummaryLine(42)).toBeNull();
  });
});

describe('summarizeAvailable', () => {
  let aiEnabled;
  beforeEach(() => {
    getAiStatus.mockReset();
    aiEnabled = true;
    query.mockReset().mockImplementation(async (sql, [userId]) => (
      /SELECT ai_enabled, is_admin FROM users/.test(sql) && userId === 'u1'
        ? { rows: [{ ai_enabled: aiEnabled, is_admin: false }] }
        : { rows: [] }
    ));
  });

  it('is true only when enabled and summarize is not disabled', async () => {
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: true } });
    expect(await summarizeAvailable('u1')).toBe(true);
    getAiStatus.mockResolvedValue({ enabled: true, features: {} }); // absent => allowed
    expect(await summarizeAvailable('u1')).toBe(true);
  });

  it('is false when disabled, when summarize is off, or when status throws', async () => {
    getAiStatus.mockResolvedValue({ enabled: false, features: { summarize: true } });
    expect(await summarizeAvailable('u1')).toBe(false);
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: false } });
    expect(await summarizeAvailable('u1')).toBe(false);
    getAiStatus.mockRejectedValue(new Error('down'));
    expect(await summarizeAvailable('u1')).toBe(false);
  });

  // #644: background summaries run on the instance's provider too, so they follow the user's switch.
  it('is false for a user whose AI access is off, an unknown user, no user, or an unreadable row', async () => {
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: true } });
    aiEnabled = false;
    expect(await summarizeAvailable('u1')).toBe(false);
    aiEnabled = true;
    expect(await summarizeAvailable('someone-else')).toBe(false);
    expect(await summarizeAvailable()).toBe(false);
    query.mockRejectedValue(new Error('connection terminated'));
    expect(await summarizeAvailable('u1')).toBe(false);
  });
});

describe('summarizeMessage', () => {
  let aiEnabled;
  beforeEach(() => {
    completeText.mockReset();
    aiEnabled = true;
    getAiStatus.mockReset().mockResolvedValue({ enabled: true, features: { summarize: true } });
    query.mockReset().mockImplementation(async (sql, [userId]) => (
      /SELECT ai_enabled, is_admin FROM users/.test(sql) && userId === 'u1'
        ? { rows: [{ ai_enabled: aiEnabled, is_admin: false }] }
        : { rows: [] }
    ));
  });

  it('sends the built prompt and returns the sanitised line', async () => {
    completeText.mockResolvedValue('"waiting on their reply 🎉"');
    const line = await summarizeMessage({ userId: 'u1', subject: 'S', from: 'Alice', content: 'body' });
    expect(line).toBe('waiting on their reply');
    expect(completeText).toHaveBeenCalledWith(
      [{ role: 'user', content: expect.stringContaining('Subject: S') }],
      { maxTokens: 120 }
    );
  });

  it('passes a custom maxLen through to the token budget', async () => {
    completeText.mockResolvedValue('short line');
    await summarizeMessage({ userId: 'u1', subject: 'S', content: 'b', maxLen: 60 });
    expect(completeText).toHaveBeenCalledWith(expect.anything(), { maxTokens: 60 });
  });

  it('returns null (never throws) when the provider errors', async () => {
    completeText.mockRejectedValue(new Error('provider down'));
    await expect(summarizeMessage({ userId: 'u1', subject: 'S', content: 'b' })).resolves.toBeNull();
  });

  // #644: plugins get summarizeMessage from the capability surface, so it checks the gate itself
  // rather than trusting the caller to have asked summarizeAvailable first.
  it('calls no provider without a user, for a user whose AI access is off, or with summaries off', async () => {
    completeText.mockResolvedValue('a line');
    expect(await summarizeMessage({ subject: 'S', content: 'b' })).toBeNull();
    expect(await summarizeMessage({ userId: 'someone-else', subject: 'S', content: 'b' })).toBeNull();
    aiEnabled = false;
    expect(await summarizeMessage({ userId: 'u1', subject: 'S', content: 'b' })).toBeNull();
    aiEnabled = true;
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: false } });
    expect(await summarizeMessage({ userId: 'u1', subject: 'S', content: 'b' })).toBeNull();
    expect(completeText).not.toHaveBeenCalled();
  });
});
