#!/usr/bin/env node
// Generates a "stargazers over time" SVG from the GitHub stargazers API using the
// repo's own token — no third-party rate limit (unlike star-history.com / starchart.cc).
// The SVG is committed to the repo and referenced from the README, so GitHub serves it
// directly and it never fails to render. Regenerated weekly by .github/workflows/sponsors.yml.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'maathimself/mailflow';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.SPONSORS_TOKEN;
const OUT = process.env.STAR_OUT || '.github/assets/star-history.svg';

async function fetchStargazers() {
  const times = [];
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/stargazers?per_page=100&page=${page}`, {
      headers: {
        // star+json media type returns the `starred_at` timestamp per stargazer.
        Accept: 'application/vnd.github.star+json',
        'User-Agent': 'mailflow-star-chart',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const s of batch) if (s.starred_at) times.push(new Date(s.starred_at).getTime());
    if (batch.length < 100) break;
  }
  return times.sort((a, b) => a - b);
}

const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function renderSvg(times) {
  const W = 800, H = 400, ML = 56, MR = 24, MT = 44, MB = 44;
  const pw = W - ML - MR, ph = H - MT - MB;
  const n = times.length;
  const t0 = times[0];
  const t1 = times[n - 1] > t0 ? times[n - 1] : t0 + 86400000;
  const span = t1 - t0;
  const maxY = Math.max(1, n);
  // Accent (#7c6af7) and neutral grey (#888) both read fine on light and dark READMEs.
  const X = (t) => ML + ((t - t0) / span) * pw;
  const Y = (c) => MT + ph - (c / maxY) * ph;

  let line = `M ${X(t0).toFixed(1)} ${Y(0).toFixed(1)}`;
  for (let i = 0; i < n; i++) line += ` L ${X(times[i]).toFixed(1)} ${Y(i + 1).toFixed(1)}`;
  const area = `${line} L ${X(t1).toFixed(1)} ${Y(0).toFixed(1)} Z`;

  let grid = '';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = Math.round((maxY / yTicks) * i);
    const y = Y(val);
    grid += `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${W - MR}" y2="${y.toFixed(1)}" stroke="#888" stroke-opacity="0.15"/>`;
    grid += `<text x="${ML - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${val}</text>`;
  }
  let xlabels = '';
  const xTicks = 4;
  for (let i = 0; i <= xTicks; i++) {
    const t = t0 + (span / xTicks) * i;
    xlabels += `<text x="${X(t).toFixed(1)}" y="${H - MB + 18}" text-anchor="middle" font-size="11" fill="#888">${fmtDate(t)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,sans-serif" role="img" aria-label="Stargazers over time for ${REPO}">
<text x="${ML}" y="26" font-size="14" font-weight="600" fill="#888">Stargazers over time · ${REPO}</text>
${grid}
${xlabels}
<path d="${area}" fill="#7c6af7" fill-opacity="0.12"/>
<path d="${line}" fill="none" stroke="#7c6af7" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
</svg>
`;
}

const times = await fetchStargazers();
if (!times.length) {
  console.error('No stargazers with timestamps returned; leaving the existing chart unchanged.');
  process.exit(0);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, renderSvg(times));
console.log(`Wrote ${OUT} - ${times.length} stars, ${fmtDate(times[0])} to ${fmtDate(times[times.length - 1])}`);
