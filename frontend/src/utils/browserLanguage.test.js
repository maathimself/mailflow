// Run with: node --test src/utils/browserLanguage.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, htmlLang } from './browserLanguage.js';

const SUPPORTED = ['en', 'de', 'fr', 'es', 'it', 'ru', 'zhCN', 'pl', 'cs', 'ptBR'];

describe('detectLanguage', () => {
  it('maps the browser tags of the shipped locales', () => {
    assert.equal(detectLanguage(['pt-BR'], SUPPORTED), 'ptBR');
    assert.equal(detectLanguage(['de-AT'], SUPPORTED), 'de');
    assert.equal(detectLanguage(['fr'], SUPPORTED), 'fr');
    assert.equal(detectLanguage(['zh-CN'], SUPPORTED), 'zhCN');
    assert.equal(detectLanguage(['zh-Hans-CN'], SUPPORTED), 'zhCN');
    assert.equal(detectLanguage(['en-US'], SUPPORTED), 'en');
  });

  it('gives European Portuguese the Brazilian locale rather than English', () => {
    assert.equal(detectLanguage(['pt-PT'], SUPPORTED), 'ptBR');
    assert.equal(detectLanguage(['pt'], SUPPORTED), 'ptBR');
  });

  it('walks the preference list until one is available', () => {
    assert.equal(detectLanguage(['ja-JP', 'ko', 'es-MX', 'en'], SUPPORTED), 'es');
  });

  it('does not show Traditional Chinese readers the Simplified locale', () => {
    assert.equal(detectLanguage(['zh-TW', 'en'], SUPPORTED), 'en');
    assert.equal(detectLanguage(['zh-Hant-HK'], SUPPORTED), 'en');
  });

  it('falls back to English for anything else, or nothing at all', () => {
    assert.equal(detectLanguage(['ja'], SUPPORTED), 'en');
    assert.equal(detectLanguage([], SUPPORTED), 'en');
    assert.equal(detectLanguage(undefined, SUPPORTED), 'en');
    assert.equal(detectLanguage(['', null], SUPPORTED), 'en');
  });

  it('accepts underscore tags as some embedded browsers report them', () => {
    assert.equal(detectLanguage(['pt_BR'], SUPPORTED), 'ptBR');
  });
});

describe('htmlLang', () => {
  it('turns locale codes into BCP 47 tags', () => {
    assert.equal(htmlLang('ptBR'), 'pt-BR');
    assert.equal(htmlLang('zhCN'), 'zh-CN');
    assert.equal(htmlLang('de'), 'de');
  });
});
