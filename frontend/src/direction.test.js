import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindDocumentDirection,
  normalizeDirectionPreference,
  normalizeLanguageTag,
  syncDocumentDirection,
} from './direction.js';

function fakeRoot() {
  const attributes = new Map();
  return {
    dataset: {},
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

function fakeI18n(language = 'en') {
  const listeners = new Set();
  return {
    language,
    resolvedLanguage: language,
    dir: (lng) => /^(ar|fa|he|ur)(-|$)/i.test(lng) ? 'rtl' : 'ltr',
    on: (event, listener) => {
      if (event === 'languageChanged') listeners.add(listener);
    },
    off: (event, listener) => {
      if (event === 'languageChanged') listeners.delete(listener);
    },
    changeLanguage(lng) {
      this.language = lng;
      this.resolvedLanguage = lng;
      for (const listener of listeners) listener(lng);
    },
    listenerCount: () => listeners.size,
  };
}

describe('interface direction', () => {
  it('normalizes unsupported preference values to auto', () => {
    assert.equal(normalizeDirectionPreference('rtl'), 'rtl');
    assert.equal(normalizeDirectionPreference('ltr'), 'ltr');
    assert.equal(normalizeDirectionPreference('sideways'), 'auto');
    assert.equal(normalizeDirectionPreference(null), 'auto');
  });

  it('normalizes stored locale identifiers for the document lang attribute', () => {
    assert.equal(normalizeLanguageTag('zhCN'), 'zh-CN');
    assert.equal(normalizeLanguageTag('ar_EG'), 'ar-EG');
    assert.equal(normalizeLanguageTag(''), 'en');
  });

  it('derives auto direction from the resolved language', () => {
    const root = fakeRoot();
    const i18n = fakeI18n('ar-EG');

    assert.equal(syncDocumentDirection(i18n, 'auto', root), 'rtl');
    assert.equal(root.getAttribute('lang'), 'ar-EG');
    assert.equal(root.getAttribute('dir'), 'rtl');
    assert.equal(root.dataset.interfaceDirection, 'auto');
  });

  it('applies an explicit direction override independently of language', () => {
    const root = fakeRoot();
    const i18n = fakeI18n('en');

    assert.equal(syncDocumentDirection(i18n, 'rtl', root), 'rtl');
    assert.equal(root.getAttribute('lang'), 'en');
    assert.equal(root.getAttribute('dir'), 'rtl');
    assert.equal(root.dataset.interfaceDirection, 'rtl');
  });

  it('keeps document direction synchronized with language changes', () => {
    const root = fakeRoot();
    const i18n = fakeI18n('en');
    const unbind = bindDocumentDirection(i18n, () => 'auto', root);

    assert.equal(root.getAttribute('dir'), 'ltr');
    assert.equal(i18n.listenerCount(), 1);

    i18n.changeLanguage('he');
    assert.equal(root.getAttribute('lang'), 'he');
    assert.equal(root.getAttribute('dir'), 'rtl');

    unbind();
    assert.equal(i18n.listenerCount(), 0);
  });
});
