// Dark-mode audit (#228), step 2 of 3: render each prepared email the way the reader does and score
// each way of showing it dark.
//
//   node scripts/dark-audit/audit.mjs <corpus-dir> [--limit N] [--only key,key]
//
// Every email is loaded into an email frame set up as the reader's (harness.html), with the
// reader's own modules, in Chromium at a reading-pane width. ALL network requests are blocked,
// apart from the harness page and those modules, which this script serves from the repo:
// rendering hundreds of real newsletters must not load their tracking pixels and mark them
// opened. Remote images therefore show as empty boxes.
//
// Ways of showing an email, each scored against the email as sent:
//   light    as sent: the baseline
//   naive    the theme's dark background and text, nothing else (the approach declined on #228)
//   sender   the sender's own dark design, forced, for emails that carry one
//   recolor  MailFlow's recoloring, forced
//   auto     what the reader shows: the sender's design, else the recoloring, else as sent,
//            whichever first leaves all text readable (utils/darkBody.js)
// Emails that ask to stay light are never shown dark by the reader, so only their light render
// is recorded.
//
// For each it records the text that reads as sent but not any more ("regressed"), the share of the
// email's area that is bright, and for auto the outcome and how long it took. After every way has
// been tried, the email is put back as sent and measured again: that must match the first
// measurement exactly, or putting an email back is not exact ("restore mismatch").
//
// Results and screenshots go to <corpus-dir>/audit/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { summarize, compareWithLight } from '../../frontend/src/utils/emailContrast.js';
import { PREPARED } from './prepare.mjs';

export const WIDTH = 720;
export const DARK_MODES = ['naive', 'sender', 'recolor', 'auto'];
const HOST = 'harness.mailflow.invalid';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// The only paths the harness host answers; anything else on it is blocked like any other request.
const SERVED = /^\/(scripts\/dark-audit\/harness\.html|frontend\/src\/utils\/[A-Za-z]+\.js)$/;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

export const applies = (email, mode) => !email.lightOnly && (mode !== 'sender' || Boolean(email.darkCss));

// Whether two light measurements of the same email are the same.
function sameMeasurement(a, b) {
  if (a.length !== b.length) return false;
  return a.every((e, i) => e.i === b[i].i && e.chars === b[i].chars && e.ratio === b[i].ratio && e.overImage === b[i].overImage);
}

// The harness page in Chromium, with every request blocked but the harness's own files. `stats`
// counts every request the emails and the harness made, how many were served from the repo and
// how many blocked; the self-test asserts nothing else happened.
// `proxyImage(u)`, when given, answers the reader's image proxy URLs (/api/mail/messages/:id/image)
// with image bytes, standing in for the backend: the self-test uses it.
const PROXY_PATH = /^\/api\/mail\/messages\/[0-9a-f-]{36}\/image$/;
// AUDIT_BROWSER picks the engine: chromium (the default), firefox or webkit. Dark email bodies
// run in the reader's own browser, so each engine is worth an audit of its own.
const ENGINES = { chromium, firefox, webkit };
export async function openHarness(stats = {}, { proxyImage = null } = {}) {
  const engine = ENGINES[process.env.AUDIT_BROWSER || 'chromium'];
  if (!engine) throw new Error(`AUDIT_BROWSER must be one of ${Object.keys(ENGINES).join(', ')}`);
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 1500 } });
  stats.requests = 0;
  stats.served = 0;
  stats.servedPaths = new Set();
  stats.blocked = 0;
  stats.proxied = 0;
  context.on('request', () => { stats.requests += 1; });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (proxyImage && url.protocol === 'http:' && url.host === HOST && PROXY_PATH.test(url.pathname)) {
      const body = proxyImage(url.searchParams.get('u'));
      if (body) { stats.proxied += 1; return route.fulfill({ contentType: 'image/png', body }); }
    }
    if (url.protocol === 'http:' && url.host === HOST && SERVED.test(url.pathname)) {
      stats.served += 1;
      stats.servedPaths.add(url.pathname);
      return route.fulfill({ path: join(REPO, url.pathname), contentType: TYPES[extname(url.pathname)] });
    }
    stats.blocked += 1;
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`http://${HOST}/scripts/dark-audit/harness.html`);
  await page.waitForFunction('window.harnessReady === true');
  return { browser, page, frame: page.locator('#frame') };
}

export async function auditEmails(emails, { shotsDir = null, onProgress, stats = {}, proxyImage = null } = {}) {
  const { browser, page, frame } = await openHarness(stats, { proxyImage });

  const shoot = async (key, mode) => {
    const png = await frame.screenshot();
    if (shotsDir) await frame.screenshot({ type: 'jpeg', quality: 55, path: join(shotsDir, `${key}-${mode}.jpg`) });
    return page.evaluate(b64 => window.harness.brightShare(b64), png.toString('base64'));
  };

  const results = [];
  for (const [index, email] of emails.entries()) {
    const result = {
      key: email.key, instance: email.instance, domain: email.domain, fromName: email.fromName,
      subject: email.subject, date: email.date, hasDarkCss: Boolean(email.darkCss), lightOnly: email.lightOnly,
      imagesBlocked: Boolean(email.imagesBlocked), modes: {},
    };
    try {
      const height = await page.evaluate(([html, css, blocked, proxied]) => window.harness.load(html, css, blocked, proxied), [email.html, email.darkCss, Boolean(email.imagesBlocked), Boolean(email.proxied)]);
      const light = await page.evaluate(() => window.harness.light());
      result.modes.light = { summary: summarize(light), bright: await shoot(email.key, 'light'), height };
      for (const mode of DARK_MODES) {
        if (!applies(email, mode)) continue;
        const shown = await page.evaluate(m => window.harness.show(m), mode);
        const entry = {
          summary: summarize(shown.dark),
          bright: await shoot(email.key, mode),
          height: shown.height,
          ...compareWithLight(light, shown.dark),
        };
        if (mode === 'auto') {
          entry.outcome = shown.outcome;
          entry.ms = Math.round(shown.ms * 10) / 10;
          entry.attempts = shown.attempts.map(a => ({ kind: a.kind, verdict: a.verdict, regressed: a.regressed }));
          entry.images = shown.images;
        }
        result.modes[mode] = entry;
      }
      await page.evaluate(() => window.harness.restore());
      const again = await page.evaluate(() => window.harness.light());
      result.restoreMismatch = !sameMeasurement(light, again);
    } catch (err) {
      result.error = err.message.split('\n')[0];
    }
    results.push(result);
    onProgress?.(index + 1, emails.length);
  }
  await browser.close();
  return results;
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

export function totals(results) {
  const out = {};
  for (const mode of ['light', ...DARK_MODES]) {
    const rows = results.filter(r => r.modes[mode]);
    const t = { emails: rows.length, medianBright: percentile(rows.map(r => r.modes[mode].bright), 0.5) };
    if (mode !== 'light') {
      for (const verdict of ['clean', 'minor', 'broken']) t[verdict] = rows.filter(r => r.modes[mode].verdict === verdict).length;
    }
    if (mode === 'auto') {
      t.outcomes = {};
      for (const r of rows) t.outcomes[r.modes.auto.outcome] = (t.outcomes[r.modes.auto.outcome] || 0) + 1;
      const darkRows = rows.filter(r => r.modes.auto.outcome !== 'light');
      t.medianBrightShownDark = percentile(darkRows.map(r => r.modes.auto.bright), 0.5);
      const ms = rows.map(r => r.modes.auto.ms);
      t.ms = { median: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: percentile(ms, 1) };
      t.images = {
        placeholders: rows.reduce((n, r) => n + (r.modes.auto.images?.placeholders || 0), 0),
        backed: rows.reduce((n, r) => n + (r.modes.auto.images?.backed || 0), 0),
        emailsWithBacked: rows.filter(r => r.modes.auto.images?.backed).length,
      };
    }
    out[mode] = t;
  }
  out.imagesBlocked = results.filter(r => r.imagesBlocked).length;
  out.restoreMismatches = results.filter(r => r.restoreMismatch).length;
  out.errors = results.filter(r => r.error).length;
  return out;
}

function parseArgs(argv) {
  const args = { dir: null, limit: Infinity, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--only') args.only = new Set(argv[++i].split(','));
    else args.dir = argv[i];
  }
  return args;
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

export function printTotals(t, log = console.log) {
  log(`light    emails ${String(t.light.emails).padStart(4)}  (the baseline)  median bright ${t.light.medianBright}`);
  for (const mode of DARK_MODES) {
    const m = t[mode];
    log(`${mode.padEnd(8)} emails ${String(m.emails).padStart(4)}  clean ${String(m.clean).padStart(4)}  minor ${String(m.minor).padStart(4)}  broken ${String(m.broken).padStart(4)}  median bright ${m.medianBright}`);
  }
  const a = t.auto;
  const o = a.outcomes;
  log(`auto outcomes: sender design ${o.sender || 0} (${pct(o.sender || 0, a.emails)}), recolored ${o.recolor || 0} (${pct(o.recolor || 0, a.emails)}), left as sent ${o.light || 0} (${pct(o.light || 0, a.emails)})`);
  log(`auto median bright when shown dark ${a.medianBrightShownDark}; time median ${a.ms.median} ms, p95 ${a.ms.p95} ms, max ${a.ms.max} ms`);
  log(`images: remote images blocked in ${t.imagesBlocked} emails; placeholders drawn dark ${a.images.placeholders}; images given a light backing ${a.images.backed} (in ${a.images.emailsWithBacked} emails)`);
  log(`restore mismatches ${t.restoreMismatches}, errors ${t.errors}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) { console.error('usage: audit.mjs <corpus-dir> [--limit N] [--only keys]'); process.exit(2); }
  let emails = readFileSync(join(args.dir, PREPARED), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  if (args.only) emails = emails.filter(e => args.only.has(e.key));
  emails = emails.slice(0, args.limit);
  const outDir = join(args.dir, 'audit');
  const shotsDir = join(outDir, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const started = Date.now();
  const stats = {};
  const results = await auditEmails(emails, {
    shotsDir, stats,
    onProgress: (done, total) => { if (done % 50 === 0 || done === total) console.error(`${done}/${total}`); },
  });
  const summary = totals(results);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ when: new Date().toISOString(), modes: ['light', ...DARK_MODES], summary, results }, null, 1));
  console.log(`audited ${results.length} emails in ${Math.round((Date.now() - started) / 1000)}s; ${stats.blocked} network requests blocked`);
  printTotals(summary);
}
