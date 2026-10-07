import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARIZE_PROMPT, summarizePromptForLocale } from './aiActions.js';

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
