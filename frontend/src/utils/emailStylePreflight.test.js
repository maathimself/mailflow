import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { preflightEmailStyles } from './emailStylePreflight.js';

// These cap-disabled, multi-megabyte cases check that malformed scans terminate
// monotonically. Production inputs have a deterministic 1 MiB pre-scan cap;
// leave enough wall-clock headroom here for loaded CI/browser workers.
const MAX_STRESS_SCAN_MS = 2000;

describe('preflightEmailStyles', () => {
  it('accepts compact ordinary email styles with bounded evidence', () => {
    const result = preflightEmailStyles('<style>.copy{color:red}</style><main><p style="color:blue">body</p></main>');
    assert.equal(result.status, 'ready');
    assert.equal(result.ruleCount, 1);
    assert.ok(result.nodeCount >= 2);
  });

  it('rejects per-value, aggregate, and node-rule work limits', () => {
    assert.equal(preflightEmailStyles('<p style="four">x</p>', { maxAuthoredStyleChars: 3 }).status, 'fallback');
    assert.equal(preflightEmailStyles('<p style="aaa">x</p><p style="bbb">x</p>', {
      maxAuthoredStyleTotalChars: 5,
    }).status, 'fallback');
    assert.equal(preflightEmailStyles('<style>.a{}.b{}</style><p>x</p><p>y</p>', {
      maxStyleWork: 3,
    }).status, 'fallback');
    assert.equal(preflightEmailStyles('<style>.a,.b{color:red}</style><p>x</p>').ruleCount, 2);
  });

  it('rejects decoded costly selectors before mounting them', () => {
    assert.equal(
      preflightEmailStyles(String.raw`<style>.x:h\61s(*){color:red}</style><p>x</p>`).status,
      'fallback',
    );
    assert.equal(
      preflightEmailStyles(String.raw`<style>.x:n\74h-child(2n){color:red}</style><p>x</p>`).status,
      'fallback',
    );
    assert.equal(
      preflightEmailStyles(String.raw`<style>.x:h\000061s(*){color:red}</style><p>x</p>`).status,
      'fallback',
    );
    for (const newline of ['\n', '\r\n', '\r', '\f']) {
      assert.equal(
        preflightEmailStyles(`<style>.x:h\\${newline}as(*){color:red}</style><p>x</p>`).status,
        'fallback',
      );
    }
    for (const selector of [
      '.x::before', '.x:AFTER', String.raw`.x::m\61 rker`, String.raw`.x::first-l\69 ne`,
    ]) {
      assert.equal(
        preflightEmailStyles(`<style>${selector}{color:red}</style><p>x</p>`).status,
        'fallback',
      );
    }
  });

  it('bounds every authored selector prelude independently of the style-block cap', () => {
    const selectorAtLimit = `.${'a'.repeat(1023)}`;
    assert.equal(preflightEmailStyles(`<style>${selectorAtLimit}{color:red}</style><p>x</p>`).status, 'ready');
    assert.equal(preflightEmailStyles(`<style>${selectorAtLimit}a{color:red}</style><p>x</p>`).status, 'fallback');
    assert.equal(
      preflightEmailStyles(`<style>.x,${'.a'.repeat(513)}{color:red}</style><p>x</p>`).status,
      'fallback',
    );
    assert.equal(
      preflightEmailStyles(`<style>${Array(400).fill('.x').join(',')}{color:red}</style><p>x</p>`).status,
      'fallback',
    );
    assert.equal(
      preflightEmailStyles(`<style>.x${'/* comment */'.repeat(100)}{color:red}</style><p>x</p>`).status,
      'fallback',
    );
    assert.equal(
      preflightEmailStyles(`<style>.x{content:"${'{'.repeat(2000)}"}</style><p>x</p>`).status,
      'ready',
    );
    const nested = depth => `${'.x{'.repeat(depth)}color:red;${'}'.repeat(depth)}`;
    assert.equal(preflightEmailStyles(`<style>${nested(8)}</style><p>x</p>`).status, 'ready');
    assert.equal(preflightEmailStyles(`<style>${nested(9)}</style><p>x</p>`).status, 'fallback');
  });

  it('rejects unproved variable and native attribute expansion before mounting', () => {
    for (const html of [
      '<p style="color:VAR(--seed)">body</p>',
      '<p style="content:ATTR(data-seed)">body</p>',
      String.raw`<p style="content:a\74 tr(data-seed)">body</p>`,
      String.raw`<style>:root{--seed:red\3b var(--branch)var(--branch);--branch:red}.x{color:var(--seed)}</style><p>body</p>`,
      String.raw`<style>:root{\2d\2d brand:#b4238d}.copy{color:v\61 r(--brand)}</style><p>body</p>`,
      '<style>:root{--seed:red}.copy{color:var(--seed, blue)}</style><p>body</p>',
      '<style>:root{--seed:red}.copy{background:linear-gradient(var(--seed),var(--seed))}</style><p>body</p>',
      '<style>:root{--seed:var(--branch);--branch:red}.copy{color:var(--seed)}</style><p>body</p>',
      '<style>:root{--seed:attr(data-seed)}.copy{color:var(--seed)}</style><p>body</p>',
      '<style>:root{--seed:env(safe-area-inset-top)}.copy{color:var(--seed)}</style><p>body</p>',
      '<style>:root{--seed:[var(--branch)var(--branch)];--branch:red}.copy{grid-template-columns:var(--seed)}</style><p>body</p>',
      '<p style="--seed:red">one</p><p style="color:var(--seed)">two</p>',
      '<style>.never{--seed:red}.copy{color:var(--seed)}</style><p class="copy">body</p>',
      '<style>@media (min-width:0){:root{--seed:red}}.copy{color:var(--seed)}</style><p class="copy">body</p>',
      `<style>:root{--seed:"${'x'.repeat(257)}"}.copy{color:var(--seed)}</style><p>body</p>`,
      `<style>:root{--seed:${'x'.repeat(257)}}.copy{color:var(--seed)}</style><p>body</p>`,
    ]) {
      assert.equal(preflightEmailStyles(html).status, 'fallback', html);
    }
  });

  it('accepts one use of an authored bounded literal variable and inert expansion-like strings', () => {
    for (const html of [
      '<p style="--brand:#b4238d;color:var(--brand)">body</p>',
      '<style>:root{/* lead */--brand:#b4238d}.copy{color:VAR(--brand)}</style><p>body</p>',
      '<style>html, body, :root{--brand:#b4238d}</style><p style="color:var(--brand)">body</p>',
      '<style>.copy--muted:hover{color:red}</style><p class="copy--muted">body</p>',
      '<style>.copy{content:"var(--not-a-use) attr(id)";color:red}</style><p>body</p>',
      '<p style="background-image:url(https://example.test/var(--not-a-use)/attr(id));color:red">body</p>',
      String.raw`<style>/* \61 */.copy{content:"\61";background:url(https://example.test/\61)}</style><p>body</p>`,
    ]) {
      assert.equal(preflightEmailStyles(html).status, 'ready', html);
    }
  });

  it('bounds every non-style attribute before native attr expansion can observe it', () => {
    assert.equal(preflightEmailStyles(`<p id="${'x'.repeat(65536)}">body</p>`).status, 'ready');
    assert.equal(preflightEmailStyles(`<p id="${'x'.repeat(65537)}">body</p>`).status, 'fallback');
    assert.equal(preflightEmailStyles(`<p data-copy=${'x'.repeat(65537)}>body</p>`).status, 'fallback');
  });

  it('rejects oversized source and node work before style analysis', () => {
    assert.equal(preflightEmailStyles('x'.repeat(2_000_000)).status, 'fallback');
    assert.equal(preflightEmailStyles('<p>x</p><p>y</p>', { maxNodes: 1 }).status, 'fallback');
  });

  it('handles a large unterminated style block in linear bounded time', () => {
    const startedAt = performance.now();
    const result = preflightEmailStyles(`<style>${'a'.repeat(2_000_000)}`, { maxSourceChars: Infinity });
    assert.equal(result.status, 'fallback');
    assert.ok(performance.now() - startedAt < MAX_STRESS_SCAN_MS);
  });

  for (const [name, html] of [
    ['repeated unterminated style tags', '<style'.repeat(400_000)],
    ['an unterminated quoted inline style', `<p style="${'a'.repeat(2_000_000)}`],
    ['repeated malformed open tags', '<p "'.repeat(500_000)],
  ]) {
    it(`scans ${name} monotonically`, () => {
      const startedAt = performance.now();
      preflightEmailStyles(html, { maxSourceChars: Infinity });
      assert.ok(performance.now() - startedAt < MAX_STRESS_SCAN_MS);
    });
  }
});
