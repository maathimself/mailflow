// Fetches GitHub Sponsors for maathimself, writes sponsors.json and rewrites the
// README block between <!-- SPONSORS-START --> and <!-- SPONSORS-END -->.
// Run weekly by .github/workflows/sponsors.yml with SPONSORS_TOKEN set.
//
// sponsors.json stays an array of { login, avatarUrl, url, ... } so older
// consumers keep working; newer fields describe the sponsor and its group.
// Amounts and tier names are read only to decide the group and are never
// written out, and groups are ordered by start date so order reveals nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BUSINESS_MIN_MONTHLY = 40;
export const ONE_TIME_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

const ENTITY_FIELDS = 'login name avatarUrl(size: 192) url websiteUrl';

export const QUERY = `
  query($after: String) {
    user(login: "maathimself") {
      sponsorshipsAsMaintainer(first: 100, after: $after, includePrivate: false, activeOnly: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          createdAt
          isActive
          isOneTimePayment
          privacyLevel
          tier { monthlyPriceInDollars isOneTime }
          sponsorEntity {
            __typename
            ... on User { ${ENTITY_FIELDS} }
            ... on Organization { ${ENTITY_FIELDS} }
          }
        }
      }
    }
  }
`;

export const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Returns the URL if it parses with an allowed protocol, otherwise null.
export function safeUrl(u, protocols = ['https:']) {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const parsed = new URL(u.trim());
    return protocols.includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

// Profile website fields are free text and often lack a scheme ("example.com").
export function normalizeWebsite(u) {
  if (typeof u !== 'string') return null;
  const t = u.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  return safeUrl(withScheme, ['https:', 'http:']);
}

// Turns raw sponsorship nodes into the sponsors.json array. Each sponsor
// appears once; an active sponsorship wins over older ones by the same account.
export function buildSponsors(nodes, now = Date.now()) {
  const byLogin = new Map();

  for (const n of nodes) {
    const e = n?.sponsorEntity;
    if (!e?.login) continue;
    if (n.privacyLevel && n.privacyLevel !== 'PUBLIC') continue;

    const tier = n.tier || null;
    const isOneTime = Boolean(tier?.isOneTime ?? n.isOneTimePayment);
    const monthly = Number.isFinite(tier?.monthlyPriceInDollars) ? tier.monthlyPriceInDollars : null;
    const created = new Date(n.createdAt).getTime();
    const recent = Number.isFinite(created) && now - created <= ONE_TIME_ACTIVE_MS;
    const active = isOneTime ? recent : Boolean(n.isActive);
    const business = active && !isOneTime && monthly !== null && monthly >= BUSINESS_MIN_MONTHLY;

    const entry = {
      login: e.login,
      avatarUrl: safeUrl(e.avatarUrl),
      url: safeUrl(e.url) || `https://github.com/${encodeURIComponent(e.login)}`,
      name: e.name || null,
      websiteUrl: normalizeWebsite(e.websiteUrl),
      type: e.__typename === 'Organization' ? 'Organization' : 'User',
      active,
      business,
      since: Number.isFinite(created) ? new Date(created).toISOString() : null,
    };

    const prev = byLogin.get(e.login);
    if (!prev || rank(entry) > rank(prev) || (rank(entry) === rank(prev) && entry.since > prev.since)) {
      byLogin.set(e.login, entry);
    }
  }

  const list = [...byLogin.values()];
  const bySince = (a, b) => String(a.since).localeCompare(String(b.since));
  const business = list.filter(s => s.business).sort(bySince);
  const regular = list.filter(s => s.active && !s.business).sort(bySince);
  const past = list.filter(s => !s.active).sort(bySince);
  // `since` only drives ordering and dedup; it is not published.
  return [...business, ...regular, ...past].map(({ since: _since, ...rest }) => rest);
}

function rank(s) {
  if (s.business) return 3;
  if (s.active) return 2;
  return 1;
}

const displayName = s => s.name || s.login;

export function renderSection(sponsors) {
  const business = sponsors.filter(s => s.business);
  const regular = sponsors.filter(s => s.active && !s.business);
  const past = sponsors.filter(s => !s.active);
  const blocks = [];

  if (business.length) {
    const items = business.map(s => {
      const href = s.websiteUrl || safeUrl(s.url) || '#';
      const src = safeUrl(s.avatarUrl);
      const label = esc(displayName(s));
      const img = src
        ? `<img src="${esc(src)}" width="96" height="96" alt="${label}" style="border-radius:12px;margin:6px">`
        : label;
      return `<a href="${esc(href)}" title="${label}">${img}</a>`;
    });
    blocks.push(`#### Business sponsors\n\n${items.join('\n')}`);
  }

  if (regular.length) {
    const items = regular.map(s => {
      const href = safeUrl(s.url) || '#';
      const src = safeUrl(s.avatarUrl);
      const label = esc(s.login);
      const img = src
        ? `<img src="${esc(src)}" width="48" height="48" alt="${label}" style="border-radius:50%;margin:4px">`
        : label;
      return `<a href="${esc(href)}" title="${label}">${img}</a>`;
    });
    blocks.push(`#### Sponsors\n\n${items.join('\n')}`);
  }

  if (!business.length && !regular.length) {
    blocks.unshift('_No sponsors yet. Be the first!_');
  }

  if (past.length) {
    const items = past.map(s => {
      const href = safeUrl(s.url);
      const label = esc(displayName(s));
      return href ? `<a href="${esc(href)}">${label}</a>` : label;
    });
    blocks.push(`#### Past supporters\n\n<sub>${items.join(', ')}</sub>`);
  }

  return blocks.join('\n\n');
}

const BLOCK_RE = /<!-- SPONSORS-START -->[\s\S]*?<!-- SPONSORS-END -->/;

export function updateReadme(readme, section) {
  if (!BLOCK_RE.test(readme)) throw new Error('README is missing the SPONSORS-START/END markers');
  // A function replacement keeps "$&" and friends in sponsor names literal.
  return readme.replace(BLOCK_RE, () => `<!-- SPONSORS-START -->\n${section}\n<!-- SPONSORS-END -->`);
}

export async function fetchSponsorships(token, fetchImpl = fetch) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const res = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { after } }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
    const { data, errors } = await res.json();
    if (errors) throw new Error(JSON.stringify(errors));
    const conn = data.user.sponsorshipsAsMaintainer;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

async function main() {
  const token = process.env.SPONSORS_TOKEN;
  if (!token) throw new Error('SPONSORS_TOKEN is not set');

  const sponsors = buildSponsors(await fetchSponsorships(token));
  writeFileSync('sponsors.json', JSON.stringify(sponsors, null, 2));

  const readme = readFileSync('README.md', 'utf8');
  const updated = updateReadme(readme, renderSection(sponsors));
  const count = sponsors.filter(s => s.active).length;
  if (updated === readme) {
    console.log('README unchanged.');
  } else {
    writeFileSync('README.md', updated);
    console.log(`Updated: ${count} active sponsor(s), ${sponsors.length - count} past supporter(s).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
