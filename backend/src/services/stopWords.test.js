import { describe, expect, it } from 'vitest';
import { STOP_WORDS, STOP_WORDS_DEFAULT } from './stopWords.js';

describe('stopWords', () => {
  it('exports a set for all 7 supported languages', () => {
    for (const lang of ['en', 'it', 'de', 'es', 'fr', 'ru', 'zhCN']) {
      expect(STOP_WORDS[lang], `missing stop-words for ${lang}`).toBeInstanceOf(Set);
    }
  });

  it('has at least 50 stop-words per language', () => {
    for (const [lang, set] of Object.entries(STOP_WORDS)) {
      expect(set.size, `${lang} has ${set.size} stop-words`).toBeGreaterThanOrEqual(50);
    }
  });

  it('defaults to the English set', () => {
    expect(STOP_WORDS_DEFAULT).toBe(STOP_WORDS.en);
  });

  it('contains common function words in Italian', () => {
    for (const word of ['il', 'la', 'di', 'e', 'che', 'non', 'per']) {
      expect(STOP_WORDS.it.has(word), `"${word}" should be an Italian stop-word`).toBe(true);
    }
  });

  it('contains common function words in the other languages', () => {
    expect(STOP_WORDS.en.has('the')).toBe(true);
    expect(STOP_WORDS.de.has('der')).toBe(true);
    expect(STOP_WORDS.es.has('el')).toBe(true);
    expect(STOP_WORDS.fr.has('le')).toBe(true);
    expect(STOP_WORDS.ru.has('и')).toBe(true);
    expect(STOP_WORDS.zhCN.has('的')).toBe(true);
  });

  it('does not contain spam-discriminative words', () => {
    for (const word of ['viagra', 'click', 'lottery', 'free']) {
      expect(STOP_WORDS.en.has(word), `"${word}" must not be a stop-word`).toBe(false);
    }
  });
});
