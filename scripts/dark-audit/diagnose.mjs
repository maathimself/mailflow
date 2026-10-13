// Dark-mode audit (#228): diagnostics for the emails an audit flagged, printing only technical facts
// (element tags, computed colors, background layers, opacity, filters, animations), never the
// email's text, sender or subject, so the output can be shared to debug MailFlow.
//
//   node scripts/dark-audit/diagnose.mjs <corpus-dir> [--keys key,key]
//
// Flagged: emails whose restore did not measure the same as sent ("restore mismatch"), and emails
// that MailFlow's recoloring left with unreadable text. For each it also runs a control: the email
// measured twice, a second apart, with nothing switched, which tells an email that changes by
// itself (an animation) from a restore that is not exact.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareWithLight } from '../../frontend/src/utils/emailContrast.js';
import { openHarness, DARK_MODES, applies } from './audit.mjs';
import { PREPARED } from './prepare.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: diagnose.mjs <corpus-dir> [--keys key,key]'); process.exit(2); }
const keysArg = process.argv.indexOf('--keys');
const { results } = JSON.parse(readFileSync(join(dir, 'audit', 'results.json'), 'utf8'));
const flagged = keysArg > 0
  ? new Map(process.argv[keysArg + 1].split(',').map(k => [k, ['asked']]))
  : new Map();
if (keysArg < 0) {
  for (const r of results) {
    const why = [];
    if (r.restoreMismatch) why.push('restore mismatch');
    if (r.modes.recolor?.verdict === 'broken' || r.modes.recolor?.verdict === 'minor') why.push(`recolor ${r.modes.recolor.verdict}`);
    if (r.modes.auto && r.modes.auto.verdict !== 'clean') why.push(`auto ${r.modes.auto.verdict}`);
    if (why.length) flagged.set(r.key, why);
  }
}
const emails = new Map(readFileSync(join(dir, PREPARED), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(e => flagged.has(e.key)).map(e => [e.key, e]));

// Measurements without the text samples.
const strip = (entries) => entries.map(({ i, chars, ratio, large, overImage }) => ({ i, chars, ratio, large, overImage }));
const differences = (a, b) => {
  const byI = new Map(b.map(e => [e.i, e]));
  const out = [];
  for (const e of a) {
    const f = byI.get(e.i);
    if (!f || f.ratio !== e.ratio || f.overImage !== e.overImage || f.chars !== e.chars) out.push({ i: e.i, before: e, after: f ?? null });
  }
  for (const f of b) if (!a.some(e => e.i === f.i)) out.push({ i: f.i, before: null, after: f });
  return out;
};

const { browser, page } = await openHarness({});
const h = (fn, arg) => page.evaluate(fn, arg);
const report = [];
for (const [key, why] of flagged) {
  const email = emails.get(key);
  if (!email) { report.push({ key, why, error: 'not in the prepared corpus' }); continue; }
  const out = { key, why, hasDarkCss: Boolean(email.darkCss) };

  // Control: nothing switched, measured twice a second apart.
  await h(([html, css, blocked]) => window.harness.load(html, css, blocked), [email.html, email.darkCss, Boolean(email.imagesBlocked)]);
  const first = strip(await h(() => window.harness.light()));
  await h(ms => window.harness.settle(ms), 1000);
  const second = strip(await h(() => window.harness.light()));
  out.control = { textPieces: first.length, changedWithoutSwitching: differences(first, second).slice(0, 10) };

  // Replay of the audit: every way of showing it, then back as sent.
  await h(([html, css, blocked]) => window.harness.load(html, css, blocked), [email.html, email.darkCss, Boolean(email.imagesBlocked)]);
  const light = strip(await h(() => window.harness.light()));
  for (const mode of DARK_MODES) if (applies(email, mode)) await h(m => window.harness.show(m), mode);
  await h(() => window.harness.restore());
  const again = strip(await h(() => window.harness.light()));
  const restoreDiff = differences(light, again).slice(0, 10);
  for (const d of restoreDiff) d.element = await h(i => window.harness.describe(i), d.i);
  out.restore = { differences: restoreDiff };

  // The recoloring alone: the text it leaves unreadable, with what is behind it as sent and recolored.
  if (applies(email, 'recolor')) {
    await h(([html, css, blocked]) => window.harness.load(html, css, blocked), [email.html, email.darkCss, Boolean(email.imagesBlocked)]);
    const sent = strip(await h(() => window.harness.light()));
    const shown = await h(() => window.harness.show('recolor'));
    const dark = strip(shown.dark);
    const comparison = compareWithLight(sent, dark);
    const sentByI = new Map(sent.map(e => [e.i, e]));
    const regressed = dark.filter(e => {
      const l = sentByI.get(e.i);
      return l && l.ratio !== null && l.ratio >= 1.5 && !l.overImage && !e.overImage && e.ratio !== null && e.ratio < 3 && l.ratio >= 3;
    }).slice(0, 8);
    const details = [];
    for (const e of regressed) details.push({ i: e.i, chars: e.chars, sentRatio: sentByI.get(e.i).ratio, recoloredRatio: e.ratio, recolored: await h(i => window.harness.describe(i), e.i) });
    await h(() => window.harness.restore());
    for (const d of details) d.sent = await h(i => window.harness.describe(i), d.i);
    out.recolor = { verdict: comparison.verdict, regressedChars: comparison.regressed, counted: comparison.counted, pieces: details };
  }
  report.push(out);
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
