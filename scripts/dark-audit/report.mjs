// Dark-mode audit (#228), step 3 of 3: a contact sheet of the audit, as one local HTML page.
//
//   node scripts/dark-audit/report.mjs <corpus-dir>
//
// Writes <corpus-dir>/audit/index.html beside the screenshots. It shows the developer's own mail,
// so it stays in the private corpus folder and is opened locally, never published.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');

const MODE_NOTES = {
  auto: 'What MailFlow shows: sender design, else recolored, else as sent',
  recolor: 'MailFlow recoloring, forced',
  sender: "Sender's own dark design, forced",
  naive: 'Theme background and text only',
};
const OUTCOME = { sender: 'sender design', recolor: 'recolored', light: 'left as sent' };

export function buildReport({ when, modes, summary, results }) {
  // What MailFlow shows first, then the ways it is made of, then the naive baseline.
  const darkModes = ['auto', 'recolor', 'sender', 'naive', ...modes].filter((m, i, all) => m !== 'light' && modes.includes(m) && all.indexOf(m) === i);
  const rows = darkModes.map(mode => {
    const t = summary[mode];
    return `<tr><th scope="row">${esc(mode)}<span class="note">${esc(MODE_NOTES[mode] || '')}</span></th>
      <td>${t.emails}</td><td>${t.clean} <span class="dim">${pct(t.clean, t.emails)}</span></td>
      <td>${t.minor} <span class="dim">${pct(t.minor, t.emails)}</span></td>
      <td class="${t.broken ? 'bad' : ''}">${t.broken} <span class="dim">${pct(t.broken, t.emails)}</span></td>
      <td>${t.medianBright === null ? '–' : `${Math.round(t.medianBright * 100)}%`}</td></tr>`;
  }).join('');
  const light = summary.light ?? { emails: results.filter(r => r.modes.light).length };
  const auto = summary.auto;
  const autoLine = auto?.outcomes ? `<p class="dim small">What MailFlow shows: ${Object.entries(OUTCOME).map(([k, label]) => `${label} ${auto.outcomes[k] || 0} (${pct(auto.outcomes[k] || 0, auto.emails)})`).join(', ')}.
    Median bright area when shown dark ${auto.medianBrightShownDark === null ? '–' : `${Math.round(auto.medianBrightShownDark * 100)}%`}.
    Time to show dark: median ${auto.ms.median} ms, 95th percentile ${auto.ms.p95} ms, slowest ${auto.ms.max} ms.
    Images: ${auto.images ? `${auto.images.placeholders} blocked-image placeholders drawn dark, ${auto.images.backed} images given a light backing` : '–'}.
    Put back as sent exactly: <span class="${summary.restoreMismatches ? 'bad' : ''}">${summary.restoreMismatches ? `${summary.restoreMismatches} mismatches` : 'every email'}</span>.</p>` : '';

  const cards = results.map(r => {
    const panels = darkModes.filter(m => r.modes[m]).map(mode => {
      const m = r.modes[mode];
      const worst = (m.worst || []).map(w => `<li><span class="ratio">${w.ratio}</span> <span class="dim">was ${w.lightRatio}</span> ${esc(w.sample)}</li>`).join('');
      return `<div class="panel" data-mode="${esc(mode)}" data-verdict="${esc(m.verdict)}" data-regressed="${m.regressed}" data-bright="${m.bright}">
        <div class="tag ${esc(m.verdict)}">${esc(mode)}${m.outcome ? ` · ${esc(OUTCOME[m.outcome] || m.outcome)}` : ''} · ${esc(m.verdict)}${m.regressed ? ` · ${m.regressed} chars` : ''} · ${Math.round(m.bright * 100)}% bright${m.ms !== undefined ? ` · ${m.ms} ms` : ''}${m.images?.backed ? ` · ${m.images.backed} images backed` : ''}</div>
        <a href="shots/${esc(r.key)}-${esc(mode)}.jpg" target="_blank"><img loading="lazy" src="shots/${esc(r.key)}-${esc(mode)}.jpg" alt="${esc(mode)} render"></a>
        ${worst ? `<ul class="worst">${worst}</ul>` : ''}
      </div>`;
    }).join('');
    const l = r.modes.light;
    return `<article class="card" data-key="${esc(r.key)}">
      <header><strong>${esc(r.domain)}</strong> <span class="dim">${esc(r.fromName)}</span>
        <div class="subject">${esc(r.subject)}</div>
        <div class="dim small">${esc(r.instance)} · ${esc(String(r.date || '').slice(0, 10))} · key ${esc(r.key)}${r.hasDarkCss ? ' · has dark design' : ''}${r.lightOnly ? ' · asks to stay light' : ''}${r.restoreMismatch ? ' · <span class="bad">not put back exactly</span>' : ''}${r.error ? ` · <span class="bad">error: ${esc(r.error)}</span>` : ''}</div>
      </header>
      <div class="panels">
        ${l ? `<div class="panel" data-mode="light"><div class="tag">light · ${l.summary.unreadable ? `${l.summary.unreadable} chars unreadable as sent` : 'as sent'}</div><a href="shots/${esc(r.key)}-light.jpg" target="_blank"><img loading="lazy" src="shots/${esc(r.key)}-light.jpg" alt="light render"></a></div>` : ''}
        ${panels}
      </div>
    </article>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dark audit contact sheet</title>
<style>
  :root { --bg: #1b1c20; --panel: #24262b; --line: #34363d; --text: #e6e6ea; --dim: #9a9ca6;
          --good: #5fbf8a; --warn: #d9b45a; --bad: #e06c6c; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--text);
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .dim { color: var(--dim); } .small { font-size: 12px; } .bad { color: var(--bad); }
  table { border-collapse: collapse; margin: 16px 0 24px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 14px 6px 0; border-bottom: 1px solid var(--line); }
  th .note { display: block; font-weight: 400; color: var(--dim); font-size: 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; }
  select, input { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: inherit; }
  .card { border-top: 1px solid var(--line); padding: 16px 0; }
  .subject { margin: 2px 0; }
  .panels { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-top: 10px; }
  .panel { background: var(--panel); border-radius: 8px; padding: 8px; min-width: 0; }
  .panel img { width: 100%; height: auto; max-height: 640px; object-fit: cover; object-position: top; display: block; border-radius: 4px; }
  .tag { font-size: 12px; margin-bottom: 6px; color: var(--dim); }
  .tag.clean { color: var(--good); } .tag.minor { color: var(--warn); } .tag.broken { color: var(--bad); }
  .worst { margin: 8px 0 0; padding-left: 18px; font-size: 12px; overflow-wrap: anywhere; }
  .ratio { color: var(--bad); font-variant-numeric: tabular-nums; }
  .hidden { display: none; }
</style></head><body>
<h1>Dark audit contact sheet</h1>
<div class="dim">${esc(when)} · ${light.emails} emails · ${summary.imagesBlocked ? `remote images blocked by MailFlow in ${summary.imagesBlocked} (its default)` : 'remote images allowed by MailFlow'}; the audit loads none, so they draw nothing</div>
<table><thead><tr><th>Mode</th><th>Emails</th><th>Clean</th><th>Minor</th><th>Broken</th><th>Median bright area</th></tr></thead><tbody>${rows}</tbody></table>
${autoLine}
<div class="dim small">Clean: no text that reads in light becomes unreadable (contrast below 3:1). Minor: at most 1% of text, or 20 characters. Bright area: share of the email's pixels that are light; lower is darker.</div>
<div class="controls" style="margin-top:16px">
  <label>Mode <select id="mode">${darkModes.map(m => `<option>${esc(m)}</option>`).join('')}</select></label>
  <label>Show <select id="verdict"><option value="">all</option><option>broken</option><option>minor</option><option>clean</option></select></label>
  <label>Sort <select id="sort"><option value="regressed">most unreadable text</option><option value="bright">brightest</option><option value="domain">sender</option></select></label>
  <label>Filter <input id="q" type="search" placeholder="sender or subject"></label>
  <span id="count" class="dim"></span>
</div>
<main id="cards">${cards}</main>
<script>
  const cards = [...document.querySelectorAll('.card')];
  const container = document.getElementById('cards');
  const $ = (id) => document.getElementById(id);
  function apply() {
    const mode = $('mode').value, verdict = $('verdict').value, q = $('q').value.toLowerCase(), sort = $('sort').value;
    const panelOf = (c) => c.querySelector('.panel[data-mode="' + mode + '"]');
    let shown = 0;
    const sorted = cards.slice().sort((a, b) => {
      if (sort === 'domain') return a.querySelector('strong').textContent.localeCompare(b.querySelector('strong').textContent);
      const pa = panelOf(a), pb = panelOf(b);
      return (pb ? Number(pb.dataset[sort]) : -1) - (pa ? Number(pa.dataset[sort]) : -1);
    });
    for (const c of sorted) {
      const p = panelOf(c);
      const text = c.querySelector('header').textContent.toLowerCase();
      const visible = Boolean(p) && (!verdict || p.dataset.verdict === verdict) && (!q || text.includes(q));
      c.classList.toggle('hidden', !visible);
      for (const other of c.querySelectorAll('.panel[data-mode]:not([data-mode="light"])')) other.classList.toggle('hidden', other !== p);
      if (visible) shown += 1;
      container.appendChild(c);
    }
    $('count').textContent = shown + ' shown';
  }
  for (const id of ['mode', 'verdict', 'sort', 'q']) $(id).addEventListener('input', apply);
  apply();
</script>
</body></html>`;
}

if (process.argv[2]) {
  const outDir = join(process.argv[2], 'audit');
  const data = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8'));
  writeFileSync(join(outDir, 'index.html'), buildReport(data));
  console.log(`report written to ${join(outDir, 'index.html')}`);
}
