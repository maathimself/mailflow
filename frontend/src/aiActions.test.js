import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_ACTION_LIMITS, AI_MESSAGE_MAX_CHARS, SUMMARIZE_PROMPT, buildAiActionContent, summarizePromptForLocale } from './aiActions.js';

describe('summarizePromptForLocale (#255)', () => {
  it('keeps the base English prompt for English and unknown/empty locales', () => {
    assert.equal(summarizePromptForLocale('en'), SUMMARIZE_PROMPT);
    assert.equal(summarizePromptForLocale('xx'), SUMMARIZE_PROMPT);
    assert.equal(summarizePromptForLocale(undefined), SUMMARIZE_PROMPT);
  });

  it('appends a language directive for supported non-English locales', () => {
    assert.equal(summarizePromptForLocale('zhCN'), `${SUMMARIZE_PROMPT} Respond in Simplified Chinese.`);
    assert.equal(summarizePromptForLocale('ko'), `${SUMMARIZE_PROMPT} Respond in Korean.`);
    assert.equal(summarizePromptForLocale('de'), `${SUMMARIZE_PROMPT} Respond in German.`);
    assert.equal(summarizePromptForLocale('cs'), `${SUMMARIZE_PROMPT} Respond in Czech.`);
    assert.equal(summarizePromptForLocale('ru'), `${SUMMARIZE_PROMPT} Respond in Russian.`);
  });
});

describe('buildAiActionContent (#633)', () => {
  const prompt = 'Summarize this email.';

  it('sends a long email whole when it fits the backend limit', () => {
    const text = 'Synthetic '.repeat(800) + 'TAIL_SENTINEL';
    const { content, truncated } = buildAiActionContent(prompt, text);
    assert.equal(content, `${prompt}\n\n${text}`);
    assert.equal(truncated, null);
  });

  it('fills the limit exactly, counting the prompt and separator', () => {
    const custom = 'p'.repeat(AI_ACTION_LIMITS.prompt);
    const text = 'x'.repeat(AI_MESSAGE_MAX_CHARS - custom.length - 2);
    const { content, truncated } = buildAiActionContent(custom, text);
    assert.equal(content.length, AI_MESSAGE_MAX_CHARS);
    assert.equal(truncated, null);
  });

  it('cuts one character over, stays within the limit and tells the model', () => {
    const custom = 'p'.repeat(AI_ACTION_LIMITS.prompt);
    const text = 'x'.repeat(AI_MESSAGE_MAX_CHARS - custom.length - 1);
    const { content, truncated } = buildAiActionContent(custom, text);
    assert.ok(content.length <= AI_MESSAGE_MAX_CHARS);
    assert.equal(truncated.total, text.length);
    assert.ok(truncated.shown < text.length);
    assert.match(content, new RegExp(`Only the first ${truncated.shown} of ${text.length} characters of this email are included above`));
  });

  it('stays within the limit for very long bodies', () => {
    const text = 'word '.repeat(400_000);
    const { content, truncated } = buildAiActionContent(prompt, text);
    assert.ok(content.length <= AI_MESSAGE_MAX_CHARS);
    assert.ok(content.length > AI_MESSAGE_MAX_CHARS - 500, 'uses nearly all of the budget');
    assert.equal(truncated.total, 2_000_000);
  });

  it('cuts at a paragraph break near the limit, else a sentence end', () => {
    const para = 'Sentence one. Sentence two.\n\n';
    const { content } = buildAiActionContent(prompt, para.repeat(2000));
    assert.match(content, /Sentence two\.\n\n\[Only the first/);
    const { content: c2 } = buildAiActionContent(prompt, 'Short sentence here. '.repeat(3000));
    assert.match(c2, /here\.\n\n\[Only the first/);
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(20_000); // no boundaries at all, so the cut falls at the budget
    const { content } = buildAiActionContent(prompt, text);
    const body = content.slice(prompt.length + 2, content.indexOf('\n\n[Only'));
    assert.equal(body.length % 2, 0);
    assert.equal(body, '😀'.repeat(body.length / 2));
  });
});
