import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEmailMediaMode } from './emailMediaMode.js';

function root({ throws = false, matches = true } = {}) {
  const element = {
    attributes: new Map(),
    setAttribute(name, value) {
      if (throws) throw new Error('blocked root attribute');
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      if (throws) throw new Error('blocked root attribute');
      this.attributes.delete(name);
    },
    style: {
      setProperty() {
        if (throws) throw new Error('blocked root style');
      },
    },
  };
  element.ownerDocument = {
    defaultView: { matchMedia: condition => ({ matches: typeof matches === 'function' ? matches(condition) : matches }) },
  };
  return element;
}

function mediaRule() {
  return {
    conditionText: '(prefers-color-scheme: dark)',
    media: { mediaText: '' },
  };
}

function sheet(rules) {
  return { ownerNode: { remove() {} }, cssRules: rules };
}

function indexedCollection(length, read) {
  return new Proxy({ length }, {
    get(target, property) {
      if (property === 'length') return target.length;
      if (/^\d+$/.test(String(property))) return read(Number(property));
      return target[property];
    },
  });
}

describe('applyEmailMediaMode bounded traversal', () => {
  it('mirrors Outlook mode attributes onto iframe html and body roots', () => {
    const documentElement = root();
    const body = root();
    const documentRoot = { nodeType: 9, documentElement, body };

    assert.equal(applyEmailMediaMode({
      root: documentRoot, styleSheets: [], scheme: 'dark',
    }).status, 'ready');
    for (const element of [documentElement, body]) {
      assert.equal(element.attributes.has('data-ogsc'), true);
      assert.equal(element.attributes.has('data-ogsb'), true);
    }

    assert.equal(applyEmailMediaMode({
      root: documentRoot, styleSheets: [], scheme: 'light',
    }).status, 'ready');
    for (const element of [documentElement, body]) {
      assert.equal(element.attributes.has('data-ogsc'), false);
      assert.equal(element.attributes.has('data-ogsb'), false);
    }
  });

  it('preserves ordinary responsive media after selecting the color scheme', () => {
    const rule = mediaRule();
    rule.conditionText = '(max-width: 600px)';

    const result = applyEmailMediaMode({
      root: root(), styleSheets: [sheet([rule])], scheme: 'dark',
    });

    assert.equal(result.status, 'ready');
    assert.equal(rule.media.mediaText, '(max-width: 600px)');
  });

  it('restores authored responsive clauses while selecting light color scheme in fail-closed mode', () => {
    const rule = mediaRule();
    rule.conditionText = '(max-width: 600px) and (prefers-color-scheme: dark)';
    const rules = [sheet([rule])];
    applyEmailMediaMode({ root: root({ matches: true }), styleSheets: rules, scheme: 'dark' });

    const result = applyEmailMediaMode({
      root: root(), styleSheets: rules, scheme: 'light', failClosed: true,
    });

    assert.equal(result.status, 'ready');
    assert.equal(rule.media.mediaText, '(max-width: 600px) and (max-width: -1px)');
  });

  it('budgets the cached authored condition again after an automatic selection', () => {
    const rule = mediaRule();
    rule.conditionText = `${' '.repeat(100)}(max-width: 600px)`;
    const rules = [sheet([rule])];
    const targetRoot = root({ matches: true });
    assert.equal(applyEmailMediaMode({
      root: targetRoot, styleSheets: rules, scheme: 'dark', maxConditionChars: Infinity,
    }).status, 'ready');

    const result = applyEmailMediaMode({
      root: targetRoot, styleSheets: rules, scheme: 'dark', maxConditionChars: 32,
    });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_condition_limit' });
  });

  it('rejects a hostile single media condition before scanning it', () => {
    const rule = mediaRule();
    rule.conditionText = `${' '.repeat(2_000_000)}(prefers-color-scheme: dark)`;
    const startedAt = performance.now();

    const result = applyEmailMediaMode({ root: root(), styleSheets: [sheet([rule])], scheme: 'dark' });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_condition_limit' });
    assert.ok(performance.now() - startedAt < 100);
  });

  it('aggregates media condition characters before rewriting', () => {
    const rules = [mediaRule(), mediaRule()];
    const result = applyEmailMediaMode({
      root: root(), styleSheets: [sheet(rules)], scheme: 'dark', maxConditionChars: 40,
    });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_condition_limit' });
  });

  it('checks the absolute deadline around every condition rewrite and at completion', () => {
    const result = applyEmailMediaMode({
      root: root(), styleSheets: [sheet([mediaRule()])], scheme: 'dark', deadline: 1, clock: () => 1,
    });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_deadline' });
  });

  it('reads no more than the 5,001st rule of an adversarially large rule list', () => {
    let reads = 0;
    const rules = indexedCollection(2_000_000, index => {
      reads += 1;
      if (index > 5000) throw new Error('read beyond budget');
      return mediaRule();
    });

    const result = applyEmailMediaMode({
      root: root(), styleSheets: [sheet(rules)], scheme: 'dark', maxConditionChars: Infinity,
    });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_rule_limit' });
    assert.equal(reads, 5001);
  });

  it('rejects an adversarial stylesheet collection without materializing it', () => {
    let reads = 0;
    const sheets = indexedCollection(2_000_000, index => {
      reads += 1;
      if (index > 0) throw new Error('read beyond first sheet');
      return sheet(indexedCollection(5001, () => ({})));
    });

    const result = applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'dark' });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_rule_limit' });
    assert.equal(reads, 0);
  });

  it('rejects an oversized empty stylesheet collection without indexing it', () => {
    let reads = 0;
    const sheets = indexedCollection(2_000_000, () => {
      reads += 1;
      throw new Error('empty sheet should not be read');
    });

    const result = applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'dark' });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_rule_limit' });
    assert.equal(reads, 0);
  });

  it('samples the deadline while processing empty sender sheets', () => {
    let reads = 0;
    const sheets = indexedCollection(5000, () => {
      reads += 1;
      return sheet([]);
    });

    const result = applyEmailMediaMode({
      root: root(), styleSheets: sheets, scheme: 'dark', deadline: 0, clock: () => 0,
    });

    assert.deepEqual(result, { status: 'fallback', reason: 'media_deadline' });
    assert.equal(reads, 64);
  });

  it('removes empty sender sheets when fail-closed deadline expires', () => {
    const entries = [];
    entries.push(...Array.from({ length: 64 }, () => {
      const owner = {
        remove() { entries.splice(entries.findIndex(item => item.ownerNode === this), 1); },
      };
      return { ownerNode: owner, cssRules: [] };
    }));
    const sheets = {
      get length() { return entries.length; },
      item(index) { return entries[index]; },
    };

    const result = applyEmailMediaMode({
      root: root(), styleSheets: sheets, scheme: 'light', failClosed: true, deadline: 0, clock: () => 0,
    });

    assert.deepEqual(result, { status: 'ready', rewrites: 0, removedSheets: 64, visitedRules: 0 });
    assert.deepEqual(entries, []);
  });

  it('removes remaining live sender sheets from the end without skipping shifted entries', () => {
    const entries = [];
    const owner = base => ({
      dataset: base ? { mailflowEmailBase: '' } : {},
      remove() { entries.splice(entries.findIndex(item => item.ownerNode === this), 1); },
    });
    const first = { ownerNode: owner(false), cssRules: indexedCollection(5001, () => ({})) };
    const second = { ownerNode: owner(false), cssRules: [] };
    const base = { ownerNode: owner(true), cssRules: [] };
    entries.push(first, second, base);
    const sheets = {
      get length() { return entries.length; },
      item(index) { return entries[index]; },
    };

    const result = applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'light', failClosed: true });

    assert.deepEqual(result, { status: 'ready', rewrites: 0, removedSheets: 2, visitedRules: 5001 });
    assert.deepEqual(entries, [base]);
  });

  it('continues after a live-list write failure without skipping the shifted next sender sheet', () => {
    const entries = [];
    const owner = base => ({
      dataset: base ? { mailflowEmailBase: '' } : {},
      remove() { entries.splice(entries.findIndex(item => item.ownerNode === this), 1); },
    });
    const broken = mediaRule();
    Object.defineProperty(broken.media, 'mediaText', { set() { throw new Error('blocked'); } });
    const first = { ownerNode: owner(false), cssRules: [broken] };
    const second = { ownerNode: owner(false), cssRules: [mediaRule()] };
    const base = { ownerNode: owner(true), cssRules: [] };
    entries.push(first, second, base);
    const sheets = {
      get length() { return entries.length; },
      item(index) { return entries[index]; },
    };

    const result = applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'dark', failClosed: true });

    assert.deepEqual(result, { status: 'ready', rewrites: 1, removedSheets: 1, visitedRules: 2 });
    assert.deepEqual(entries, [second, base]);
  });

  it('counts a shared failing owner once even when it appears in multiple sheets', () => {
    let removals = 0;
    const owner = { remove() { removals += 1; } };
    const brokenRule = () => {
      const rule = mediaRule();
      Object.defineProperty(rule.media, 'mediaText', { set() { throw new Error('blocked'); } });
      return rule;
    };
    const sheets = [
      { ownerNode: owner, cssRules: [brokenRule()] },
      { ownerNode: owner, cssRules: [brokenRule()] },
    ];

    const result = applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'dark', failClosed: true });

    assert.deepEqual(result, { status: 'ready', rewrites: 0, removedSheets: 1, visitedRules: 2 });
    assert.equal(removals, 1);
  });
});

describe('applyEmailMediaMode exception union', () => {
  it('contains root write errors', () => {
    assert.deepEqual(
      applyEmailMediaMode({ root: root({ throws: true }), styleSheets: [], scheme: 'dark' }),
      { status: 'fallback', reason: 'media_rule_unwritable' },
    );
  });

  it('contains a stylesheet collection length error', () => {
    const sheets = { get length() { throw new Error('blocked length'); } };
    assert.deepEqual(
      applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'dark' }),
      { status: 'fallback', reason: 'media_rule_unwritable' },
    );
  });

  it('contains a stylesheet collection item error', () => {
    const sheets = { length: 1, item() { throw new Error('blocked item'); } };
    assert.deepEqual(
      applyEmailMediaMode({ root: root(), styleSheets: sheets, scheme: 'dark' }),
      { status: 'fallback', reason: 'media_rule_unwritable' },
    );
  });
});
