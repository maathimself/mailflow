import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGtdRowListener, gtdRowSession, gtdRowLabeled, gtdRowChanged, gtdRowsSettled } from './gtdRowEvents.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

describe('GTD row events', () => {
  it('are no-ops without a listener', () => {
    setGtdRowListener(null);
    assert.equal(gtdRowSession(), null);
    assert.doesNotThrow(() => {
      gtdRowLabeled({ id: 'm' }, 'todo', null, null);
      gtdRowChanged({ id: 'm' }, null);
      gtdRowsSettled(null);
    });
  });

  it('hand every outcome to the registered listener with its session', () => {
    const calls = [];
    setGtdRowListener({
      session: () => 7,
      labeled: (...args) => calls.push(['labeled', ...args]),
      changed: (...args) => calls.push(['changed', ...args]),
      settled: (...args) => calls.push(['settled', ...args]),
    });
    try {
      const session = gtdRowSession();
      gtdRowLabeled('m1', 'watch', 'd', session);
      gtdRowChanged('m2', session);
      gtdRowsSettled(session);
      assert.deepEqual(calls, [['labeled', 'm1', 'watch', 'd', 7], ['changed', 'm2', 7], ['settled', 7]]);
    } finally {
      setGtdRowListener(null);
    }
  });

  it('the GTD plugin registers the row chips as the listener when it loads', async () => {
    const { getGtdMetadata, clearGtdMetadata } = await import('../plugins/gtd/metadataStore.js');
    clearGtdMetadata();
    gtdRowLabeled({ id: 'row-event', account_id: 'a' }, 'todo', null, gtdRowSession());
    assert.deepEqual(getGtdMetadata('row-event').states, ['todo']);
    clearGtdMetadata();
  });
});

describe('frontend plugin boundary', () => {
  it('no core module imports GTD plugin code', () => {
    const offenders = [];
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'plugins') walk(path);
        } else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) {
          if (/from\s+['"][^'"]*plugins\/gtd\//.test(readFileSync(path, 'utf8'))) offenders.push(relative(SRC, path));
        }
      }
    };
    walk(SRC);
    assert.deepEqual(offenders, []);
  });
});
