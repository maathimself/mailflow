// Run with: node --test src/themes.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES,
  applyCustomCss,
  applyTheme,
  subscribeAppearanceChanges,
} from './themes.js';

const names = Object.keys(THEMES);

// The canonical CSS-variable contract every theme must satisfy is taken from the
// first theme rather than a hardcoded list — so the check tracks the real set and a
// var added to every theme can never drift out of sync with this test.
const [reference] = names;
const canonicalVars = Object.keys(THEMES[reference].vars);

// One theme (parchment) intentionally carries a var the others don't need
// (--selection-bg, a sepia selection tint that only the light parchment surface
// wants). The invariant we pin is "no theme silently OMITS a canonical var", so
// extras beyond the canonical set are tolerated only from this known list — a *new*
// stray var still trips the guard and has to be justified (added everywhere or listed).
const KNOWN_THEME_EXTRAS = new Set(['--selection-bg']);

describe('THEMES CSS-var contract', () => {
  it('every theme defines all canonical CSS vars (no silent omissions)', () => {
    for (const name of names) {
      const keys = new Set(Object.keys(THEMES[name].vars));
      const missing = canonicalVars.filter(v => !keys.has(v));
      assert.deepEqual(missing, [], `${name} is missing vars: ${missing.join(', ')}`);
    }
  });

  it('no theme introduces an unexpected CSS var beyond the canonical set', () => {
    const canonical = new Set(canonicalVars);
    for (const name of names) {
      const extras = Object.keys(THEMES[name].vars)
        .filter(v => !canonical.has(v) && !KNOWN_THEME_EXTRAS.has(v));
      assert.deepEqual(extras, [], `${name} has unexpected vars: ${extras.join(', ')}`);
    }
  });

  it('every theme preview is an array of the same arity', () => {
    const arity = THEMES[reference].preview.length;
    for (const name of names) {
      assert.ok(Array.isArray(THEMES[name].preview), `${name} preview must be an array`);
      assert.equal(THEMES[name].preview.length, arity, `${name} preview arity differs from ${reference}`);
    }
  });
});

function fakeDocument() {
  const nodes = new Map();
  const appendChild = node => {
    node.isConnected = true;
    if (node.id) nodes.set(node.id, node);
  };
  return {
    documentElement: {},
    head: { appendChild },
    createElement: () => ({
      style: {},
      isConnected: false,
      remove() {
        this.isConnected = false;
        nodes.delete(this.id);
      },
    }),
    getElementById: id => nodes.get(id) || null,
    querySelector: () => null,
  };
}

function withThemeDocument(run) {
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = fakeDocument();
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => 'blue' });
  try {
    run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
}

describe('appearance change notifications', () => {
  it('publishes one synchronous event after theme and custom-CSS mutations', () => {
    withThemeDocument(() => {
      const events = [];
      const unsubscribe = subscribeAppearanceChanges(event => {
        events.push({
          ...event,
          themeCss: document.getElementById('mailflow-theme')?.textContent,
          customCss: document.getElementById('mailflow-custom-css')?.textContent || null,
        });
      });

      try {
        applyTheme('light');
        assert.equal(events.length, 1);
        applyCustomCss(':root { --accent: #f00; }');
        assert.equal(events.length, 2);
        applyCustomCss('');
        assert.equal(events.length, 3);
      } finally {
        unsubscribe();
      }

      assert.deepEqual(events.map(event => event.themeName), ['light', 'light', 'light']);
      assert.ok(events[0].themeCss.includes('--bg-primary: #f0f0f5;'));
      assert.equal(events[1].customCss, ':root { --accent: #f00; }');
      assert.equal(events[2].customCss, null);
    });
  });

  it('stops events after unsubscribe and isolates listener exceptions', () => {
    withThemeDocument(() => {
      const events = [];
      const stopBroken = subscribeAppearanceChanges(() => { throw new Error('listener failure'); });
      const stopHealthy = subscribeAppearanceChanges(event => events.push(event));

      try {
        applyTheme('dark');
        stopHealthy();
        applyTheme('light');
      } finally {
        stopBroken();
      }

      assert.deepEqual(events, [{ themeName: 'dark' }]);
    });
  });

  it('falls back inherited theme keys to dark before notifying listeners', () => {
    for (const inheritedName of ['toString', 'constructor', '__proto__']) {
      withThemeDocument(() => {
        const events = [];
        const unsubscribe = subscribeAppearanceChanges(event => events.push({
          ...event,
          themeCss: document.getElementById('mailflow-theme')?.textContent,
        }));

        try {
          assert.doesNotThrow(() => applyTheme(inheritedName), inheritedName);
        } finally {
          unsubscribe();
        }

        assert.deepEqual(events.map(event => event.themeName), ['dark'], inheritedName);
        assert.ok(events[0].themeCss.includes('--bg-primary: #0f0f11;'), inheritedName);
      });
    }
  });
});
