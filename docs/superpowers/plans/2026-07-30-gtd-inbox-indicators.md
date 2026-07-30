---
last_edited: 2026-07-30
---

# GTD Inbox Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Color successful GTD classification toasts and show canonical GTD state or aging indicators before dates in normal inbox rows without adding an API or database round trip.

**Architecture:** Extend each existing inbox-list SQL statement so it pages first, resolves configured GTD-folder matches for only those page threads, and returns `gtd_states` plus a compact `gtd_dates` map in the same query. Keep presentation rules pure in `utils/gtd.js`, render them through one small shared component in both top-level inbox row variants, optimistically patch the visible row after classification succeeds, and let the generic toaster opt into GTD colors only when a successful notification carries `gtdState`.

**Tech Stack:** Node.js 22, PostgreSQL, Express service layer, React 18, Zustand, i18next, Node test runner, Vitest, ESLint, Vite.

## Global Constraints

- Keep the existing inbox request as the only request required to render GTD indicators.
- Do not add dependencies, endpoints, migrations, persistent columns, or feature flags.
- Only normal INBOX rows are in scope; search results, non-INBOX folders, and expanded thread sub-rows stay unchanged.
- Support Todo, Watch, Delegated, Reference, and Someday in account and unified inboxes and flat and threaded views.
- Show all valid multiple labels on one thread rather than collapsing to one state.
- Canonical indicator order is Todo, Watch, Delegated, Reference, Someday.
- Reuse `GTD_COLORS`, `GTD_CHIP_BG`, `agingDays`, `agingLabel`, `isStale`, and the existing 14-day stale threshold.
- Preserve unrelated and failure-toast styling.
- The pushed branch must contain exactly one Conventional Commit with a subject under 72 characters.
- The pull request must target `main`, fill every repository-template section, affirm both CLA checkboxes, and wait for CI and maintainer review before merge or production release.

---

### Task 1: Return GTD metadata in the existing inbox SQL calls

**Files:**
- Modify: `backend/src/services/messageService.js`
- Test: `backend/src/services/messageService.test.js`

**Interfaces:**
- Consumes: existing `listMessages({ userId, accountId, folder, limit, offset, unreadOnly, threaded, category })`.
- Produces: normal INBOX rows with `gtd_states: string[]`, `gtd_dates: Record<string,string>`, and `gtd_date: string|null`; query-call counts remain unchanged.

- [ ] **Step 1: Add failing flat and threaded metadata tests**

Add tests that mock a returned row with the new fields and inspect the generated SQL:

```js
it.each([
  ['flat', undefined],
  ['threaded', 'true'],
])('returns ordered GTD metadata in the existing %s inbox query', async (_mode, threaded) => {
  query
    .mockResolvedValueOnce({ rows: [{ id: 'acc-1', include_in_unified_inbox: true }] })
    .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
    .mockResolvedValueOnce({
      rows: [{
        id: 'msg-1',
        account_id: 'acc-1',
        thread_key: 'thread-1',
        gtd_states: ['todo', 'watch', 'reference'],
        gtd_dates: {
          todo: '2026-07-27T12:00:00Z',
          watch: '2026-07-20T12:00:00Z',
          reference: '2026-07-26T12:00:00Z',
        },
        gtd_date: '2026-07-27T12:00:00Z',
      }],
    });
  if (threaded) query.mockResolvedValueOnce({ rows: [{ total: 1 }] });

  const result = await listMessages({
    userId: 'user-1',
    accountId: 'acc-1',
    folder: 'INBOX',
    threaded,
  });

  expect(result.messages[0]).toMatchObject({
    gtd_states: ['todo', 'watch', 'reference'],
    gtd_dates: {
      todo: '2026-07-27T12:00:00Z',
      watch: '2026-07-20T12:00:00Z',
      reference: '2026-07-26T12:00:00Z',
    },
    gtd_date: '2026-07-27T12:00:00Z',
  });
  const listSql = query.mock.calls[2][0];
  expect(listSql).toContain('gtd_matches');
  expect(listSql).toContain('gtd_metadata');
  expect(listSql).toContain('gtd_states');
  expect(listSql).toContain('gtd_dates');
  expect(listSql).toContain('gtd_date');
});
```

Add focused SQL-shape assertions proving that:

```js
expect(listSql).toMatch(/gm\.account_id\s*=\s*pt\.account_id/);
expect(listSql).toMatch(/gm\.thread_key\s*=\s*pt\.thread_key/);
expect(listSql).toContain("COALESCE(NULLIF(a.gtd_folders->>'todo', ''), 'Todo')");
expect(listSql).toContain("COALESCE(NULLIF(a.gtd_folders->>'someday', ''), 'Someday')");
expect(listSql).toContain('a.gtd_enabled = true');
expect(listSql).toContain('ORDER BY sort_order');
```

Add a non-INBOX test asserting `gtd_matches` is absent so other folders pay no GTD lookup cost.

- [ ] **Step 2: Run the focused backend test and confirm RED**

Run:

```bash
cd backend
npx vitest run src/services/messageService.test.js
```

Expected: the new assertions fail because the list SQL does not yet define `gtd_matches`, `gtd_metadata`, `gtd_states`, `gtd_dates`, or `gtd_date`.

- [ ] **Step 3: Page first and aggregate GTD metadata inside each existing query**

In `messageService.js`, introduce one canonical state-to-folder SQL fragment:

```js
const GTD_STATE_VALUES_SQL = `
  VALUES
    ('todo',      COALESCE(NULLIF(a.gtd_folders->>'todo', ''),      'Todo'),      1),
    ('watch',     COALESCE(NULLIF(a.gtd_folders->>'watch', ''),     'Watch'),     2),
    ('delegated', COALESCE(NULLIF(a.gtd_folders->>'delegated', ''), 'Delegated'), 3),
    ('reference', COALESCE(NULLIF(a.gtd_folders->>'reference', ''), 'Reference'), 4),
    ('someday',   COALESCE(NULLIF(a.gtd_folders->>'someday', ''),   'Someday'),   5)
`;
```

For INBOX queries, shape the SQL around these CTE responsibilities:

```sql
page_threads AS (
  SELECT DISTINCT account_id, thread_key
  FROM page
),
gtd_matches AS (
  SELECT gm.account_id,
         gm.thread_key,
         state_map.state,
         state_map.sort_order,
         MAX(gm.date) AS state_date
  FROM page_threads pt
  JOIN email_accounts a
    ON a.id = pt.account_id
   AND a.gtd_enabled = true
  CROSS JOIN LATERAL (
    VALUES
      ('todo',      COALESCE(NULLIF(a.gtd_folders->>'todo', ''),      'Todo'),      1),
      ('watch',     COALESCE(NULLIF(a.gtd_folders->>'watch', ''),     'Watch'),     2),
      ('delegated', COALESCE(NULLIF(a.gtd_folders->>'delegated', ''), 'Delegated'), 3),
      ('reference', COALESCE(NULLIF(a.gtd_folders->>'reference', ''), 'Reference'), 4),
      ('someday',   COALESCE(NULLIF(a.gtd_folders->>'someday', ''),   'Someday'),   5)
  ) AS state_map(state, folder, sort_order)
  JOIN messages gm
    ON gm.account_id = pt.account_id
   AND gm.thread_key = pt.thread_key
   AND gm.folder = state_map.folder
   AND gm.is_deleted = false
  GROUP BY gm.account_id, gm.thread_key, state_map.state, state_map.sort_order
),
gtd_metadata AS (
  SELECT account_id,
         thread_key,
         ARRAY_AGG(state ORDER BY sort_order) AS gtd_states,
         JSONB_OBJECT_AGG(state, state_date) AS gtd_dates,
         MAX(state_date) AS gtd_date
  FROM gtd_matches
  GROUP BY account_id, thread_key
)
```

Wrap the flat result in a `page` CTE so `LIMIT/OFFSET` happen before the GTD
lookup, and include `m.thread_key` in that internal page shape. In threaded
mode, retain the current `paged_threads`, dedupe, totals, and ranking behavior,
create a page CTE from `ranked WHERE rn = 1`, and treat its existing
`thread_id` field as the thread key. Join metadata on both `account_id` and the
appropriate thread field:

```sql
SELECT page.*,
       COALESCE(gtd_metadata.gtd_states, ARRAY[]::text[]) AS gtd_states,
       COALESCE(gtd_metadata.gtd_dates, '{}'::jsonb) AS gtd_dates,
       gtd_metadata.gtd_date
FROM page
LEFT JOIN gtd_metadata
  ON gtd_metadata.account_id = page.account_id
 AND gtd_metadata.thread_key = page.thread_key -- page.thread_id in threaded mode
ORDER BY page.date DESC
```

For account-specific non-INBOX queries, keep the current SQL without the GTD CTEs and metadata fields. Do not add a query call.

- [ ] **Step 4: Run backend tests and confirm GREEN**

Run:

```bash
cd backend
npx vitest run src/services/messageService.test.js
```

Expected: all `messageService` tests pass, including unchanged query-call-count assumptions.

- [ ] **Step 5: Commit the backend unit**

```bash
git add backend/src/services/messageService.js backend/src/services/messageService.test.js
git commit -m "feat: add GTD metadata to inbox rows"
```

---

### Task 2: Define pure inbox-indicator and toast-appearance rules

**Files:**
- Modify: `frontend/src/utils/gtd.js`
- Modify: `frontend/src/utils/gtd.test.js`
- Create: `frontend/src/utils/notificationAppearance.js`
- Create: `frontend/src/utils/notificationAppearance.test.js`

**Interfaces:**
- Produces: `buildInboxGtdIndicators(message, t, now)` returning `{ state, label, color, background }[]`.
- Produces: `resolveToastAppearance(notification)` returning `{ iconColor, iconBackground, bodyColor }`.
- Consumes: existing GTD constants and aging helpers.

- [ ] **Step 1: Add failing indicator-descriptor tests**

Import `buildInboxGtdIndicators` and add:

```js
describe('buildInboxGtdIndicators', () => {
  const t = key => key.replace('gtd.state.', '').replace(/^./, c => c.toUpperCase());
  const now = Date.parse('2026-07-30T12:00:00Z');

  it('dedupes and returns all states in canonical indicator order', () => {
    const indicators = buildInboxGtdIndicators({
      gtd_states: ['someday', 'watch', 'todo', 'reference', 'watch', 'delegated'],
      gtd_dates: {
        watch: '2026-07-20T12:00:00Z',
        delegated: '2026-07-28T12:00:00Z',
      },
      gtd_date: '2026-07-28T12:00:00Z',
    }, t, now);
    assert.deepEqual(indicators.map(x => x.state), [
      'todo', 'watch', 'delegated', 'reference', 'someday',
    ]);
    assert.deepEqual(indicators.map(x => x.label), [
      'Todo', '⏱ 10d', '⏱ 2d', 'Reference', 'Someday',
    ]);
  });

  it('uses stale red for waiting states past 14 days', () => {
    const [watch] = buildInboxGtdIndicators({
      gtd_states: ['watch'],
      gtd_date: '2026-07-10T12:00:00Z',
    }, t, now);
    assert.equal(watch.color, '#ff9b9b');
    assert.equal(watch.background, 'rgba(248,113,113,.16)');
  });

  it('falls back to the state name when a waiting date is missing', () => {
    const [delegated] = buildInboxGtdIndicators({ gtd_states: ['delegated'] }, t, now);
    assert.equal(delegated.label, 'Delegated');
  });

  it('ignores malformed and unsupported state metadata', () => {
    assert.deepEqual(buildInboxGtdIndicators({ gtd_states: 'watch' }, t, now), []);
    assert.deepEqual(buildInboxGtdIndicators({ gtd_states: ['unknown'] }, t, now), []);
  });
});
```

- [ ] **Step 2: Add failing toast-appearance tests**

Create `notificationAppearance.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToastAppearance } from './notificationAppearance.js';

describe('resolveToastAppearance', () => {
  it('uses canonical GTD colors when gtdState is present', () => {
    assert.deepEqual(resolveToastAppearance({ gtdState: 'watch' }), {
      iconColor: '#D9B430',
      iconBackground: 'rgba(217,180,48,0.15)',
      bodyColor: '#D9B430',
    });
  });

  it('keeps error and default appearances unchanged', () => {
    assert.deepEqual(resolveToastAppearance({ type: 'error' }), {
      iconColor: 'var(--red)',
      iconBackground: 'rgba(248,113,113,0.15)',
      bodyColor: 'var(--text-tertiary)',
    });
    assert.deepEqual(resolveToastAppearance({}), {
      iconColor: 'var(--accent)',
      iconBackground: 'var(--accent-dim)',
      bodyColor: 'var(--text-tertiary)',
    });
  });
});
```

- [ ] **Step 3: Run focused frontend tests and confirm RED**

Run:

```bash
cd frontend
node --test src/utils/gtd.test.js src/utils/notificationAppearance.test.js
```

Expected: imports fail because both functions/files are absent.

- [ ] **Step 4: Implement the pure descriptor functions**

In `gtd.js`, add:

```js
export const GTD_INDICATOR_ORDER = ['todo', 'watch', 'delegated', 'reference', 'someday'];

export function buildInboxGtdIndicators(message, t, now = Date.now()) {
  if (!Array.isArray(message?.gtd_states)) return [];
  const stateSet = new Set(message.gtd_states.filter(state => GTD_INDICATOR_ORDER.includes(state)));
  return GTD_INDICATOR_ORDER
    .filter(state => stateSet.has(state))
    .map(state => {
      const waiting = state === 'watch' || state === 'delegated';
      const days = agingDays(message?.gtd_dates?.[state] || message?.gtd_date, now);
      const stale = waiting && isStale(days);
      return {
        state,
        label: waiting && days != null ? agingLabel(days) : t(`gtd.state.${state}`),
        color: stale ? '#ff9b9b' : GTD_COLORS[state],
        background: stale ? 'rgba(248,113,113,.16)' : GTD_CHIP_BG[state],
      };
    });
}
```

Create `notificationAppearance.js` with error precedence and a validated GTD-state lookup:

```js
import { GTD_CHIP_BG, GTD_COLORS } from './gtd.js';

export function resolveToastAppearance(notification = {}) {
  if (notification.type === 'error') {
    return {
      iconColor: 'var(--red)',
      iconBackground: 'rgba(248,113,113,0.15)',
      bodyColor: 'var(--text-tertiary)',
    };
  }
  const state = notification.gtdState;
  if (GTD_COLORS[state] && GTD_CHIP_BG[state]) {
    return {
      iconColor: GTD_COLORS[state],
      iconBackground: GTD_CHIP_BG[state],
      bodyColor: GTD_COLORS[state],
    };
  }
  return {
    iconColor: 'var(--accent)',
    iconBackground: 'var(--accent-dim)',
    bodyColor: 'var(--text-tertiary)',
  };
}
```

- [ ] **Step 5: Run focused frontend tests and confirm GREEN**

Run:

```bash
cd frontend
node --test src/utils/gtd.test.js src/utils/notificationAppearance.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit the pure frontend unit**

```bash
git add frontend/src/utils/gtd.js frontend/src/utils/gtd.test.js \
  frontend/src/utils/notificationAppearance.js frontend/src/utils/notificationAppearance.test.js
git commit -m "feat: define GTD indicator appearances"
```

---

### Task 3: Render inbox indicators in both top-level row variants

**Files:**
- Create: `frontend/src/components/GtdInboxIndicators.jsx`
- Modify: `frontend/src/components/MessageList.jsx`

**Interfaces:**
- Consumes: `buildInboxGtdIndicators(message, t)` from Task 2.
- Produces: `<GtdInboxIndicators message={message} />`, rendering nothing for absent metadata.

- [ ] **Step 1: Create the focused indicator component**

```jsx
import { useTranslation } from 'react-i18next';
import { buildInboxGtdIndicators } from '../utils/gtd.js';

export default function GtdInboxIndicators({ message }) {
  const { t } = useTranslation();
  const indicators = buildInboxGtdIndicators(message, t);
  if (indicators.length === 0) return null;

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      minWidth: 0, overflow: 'hidden',
    }}>
      {indicators.map(indicator => (
        <span key={indicator.state} style={{
          color: indicator.color,
          background: indicator.background,
          borderRadius: 7,
          padding: '0 5px',
          fontSize: 10,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {indicator.label}
        </span>
      ))}
    </span>
  );
}
```

- [ ] **Step 2: Place the component immediately before each top-level date**

Import `GtdInboxIndicators` in `MessageList.jsx`. Pass
`showGtdIndicators={selectedFolder === 'INBOX' && !searchQuery.trim()}` to both
`ThreadRow` and `MessageRow`, add that boolean to both component signatures,
and place this markup in the threaded header’s right-side metadata cluster and
the flat `MessageRow` metadata cluster:

```jsx
{showGtdIndicators && <GtdInboxIndicators message={message} />}
<span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
  {formatDate(message.date)}
</span>
```

Do not add the component to expanded thread sub-rows or GTD section rows.

- [ ] **Step 3: Run frontend lint, focused tests, and build**

Run:

```bash
cd frontend
npm run lint
node --test src/utils/gtd.test.js src/utils/notificationAppearance.test.js
npm run build
```

Expected: all commands pass; Vite completes a production build.

- [ ] **Step 4: Commit the inbox rendering unit**

```bash
git add frontend/src/components/GtdInboxIndicators.jsx frontend/src/components/MessageList.jsx
git commit -m "feat: show GTD indicators in inbox rows"
```

---

### Task 4: Apply GTD colors to successful classification toasts

**Files:**
- Modify: `frontend/src/utils/gtd.js`
- Modify: `frontend/src/utils/gtd.test.js`
- Modify: `frontend/src/components/NotificationToasts.jsx`

**Interfaces:**
- Consumes: `resolveToastAppearance(notification)` from Task 2.
- Produces: successful `classifyThread` notifications with `gtdState`; no state metadata on failures/removals.
- Produces: an optional post-success callback and pure metadata patch so the
  classified inbox row updates without another list request.

- [ ] **Step 1: Add a failing classification-notification test**

Extend the existing `classifyThread` tests to capture the notification:

```js
it('tags only a successful classify notification with its GTD state', async () => {
  const success = [];
  await classifyThread('m1', 'reference', {
    gtdClassify: async () => {},
    addNotification: value => success.push(value),
    scheduleGtdSectionsFetch: () => {},
    t: key => key,
  });
  assert.deepEqual(success, [{
    title: 'gtd.classified',
    body: 'gtd.state.reference',
    gtdState: 'reference',
  }]);

  const failure = [];
  await classifyThread('m1', 'reference', {
    gtdClassify: async () => { throw new Error('no'); },
    addNotification: value => failure.push(value),
    scheduleGtdSectionsFetch: () => {},
    t: key => key,
  });
  assert.equal(failure[0].gtdState, undefined);
});
```

- [ ] **Step 2: Run the classification test and confirm RED**

Run:

```bash
cd frontend
node --test src/utils/gtd.test.js
```

Expected: the success payload lacks `gtdState`.

- [ ] **Step 3: Add metadata and consume the appearance resolver**

Change only the success notification in `classifyThread`:

```js
addNotification({
  title: t('gtd.classified'),
  body: t(`gtd.state.${state}`),
  gtdState: state,
});
```

Also call an optional `onClassified(state)` dependency only after the API
request succeeds. In `MessageList`, use it with a pure
`buildGtdMetadataPatch(message, state)` helper to update `gtd_states`,
`gtd_dates`, and `gtd_date` in Zustand. Preserve existing metadata and canonical
ordering; never patch the row on a failed request.

In `NotificationToasts.jsx`, resolve appearance once in `Toast`:

```jsx
const appearance = resolveToastAppearance(notification);
```

Use `appearance.iconBackground`, `appearance.iconColor`, and
`appearance.bodyColor` in the existing icon container and body text styles.
Keep the envelope/error SVG selection and all layout, timing, and actions
unchanged.

- [ ] **Step 4: Run focused tests, lint, and build**

Run:

```bash
cd frontend
node --test src/utils/gtd.test.js src/utils/notificationAppearance.test.js
npm run lint
npm run build
```

Expected: all commands pass.

- [ ] **Step 5: Commit the toast unit**

```bash
git add frontend/src/utils/gtd.js frontend/src/utils/gtd.test.js \
  frontend/src/components/NotificationToasts.jsx
git commit -m "feat: color GTD classification toasts"
```

---

### Task 5: Verify the complete feature and query cost

**Files:**
- Modify only if verification exposes a defect.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: recorded evidence for Kata and the pull request.

- [ ] **Step 1: Run the repository’s full CI-equivalent checks**

Run:

```bash
cd backend
npm run lint
node --check src/index.js
npm test
npm audit --omit=dev --audit-level=high

cd ../frontend
npm run lint
npm run build
npm test
npm audit --omit=dev --audit-level=high
```

Expected: every command passes. If an audit fails only because the registry is
unreachable, record that exact limitation; do not claim the audit passed.

- [ ] **Step 2: Inspect SQL shape and runtime query plan**

Confirm the generated flat and threaded list SQL each contain one page-bounded
GTD aggregation and that query-call counts did not increase. If a configured
local PostgreSQL database is available, run `EXPLAIN (ANALYZE, BUFFERS)` for a
representative 50-row account and unified inbox query and confirm indexed scans
on the existing message thread/folder indexes with no full messages-table scan
introduced by GTD metadata. If no representative database is available, report
that timing was not measured and rely only on the SQL-shape and unit-test
evidence.

- [ ] **Step 3: Review the diff against every spec requirement**

Check:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Verify the diff is limited to the approved design, plan, backend list service
and tests, frontend GTD/notification utilities and tests, the shared indicator
component, and the two integration components.

---

### Task 6: Squash, publish, and open the maintainer-compliant pull request

**Files:**
- No source changes expected.

**Interfaces:**
- Produces: one-commit branch and a ready-for-review PR targeting `main`.

- [ ] **Step 1: Squash all branch commits to exactly one**

Preserve the complete working tree while replacing the branch’s intermediate
commits:

```bash
git reset --soft origin/main
git commit -m "feat: show GTD indicators in inbox rows"
test "$(git rev-list --count origin/main..HEAD)" -eq 1
```

Expected: the assertion succeeds and the single subject is a Conventional
Commit under 72 characters.

- [ ] **Step 2: Push the dedicated branch**

```bash
git push -u origin feat/gtd-inbox-indicators
```

- [ ] **Step 3: Open a PR using the complete maintainer template**

Use a body with all required sections and checked CLA boxes:

```markdown
## Summary

Show GTD classification colors at apply time and surface every GTD state on
normal inbox rows without adding a request or database round trip.

## Changes

- enrich page-bounded flat and threaded inbox queries with configured GTD state metadata
- show canonical Todo, Watch, Delegated, Reference, and Someday indicators before row dates
- reuse waiting-age and stale styling, including custom account folder mappings
- color successful GTD classification toast icons and applied-state text

## Testing

- `cd backend && npm run lint`
- `cd backend && node --check src/index.js`
- `cd backend && npm test`
- `cd backend && npm audit --omit=dev --audit-level=high`
- `cd frontend && npm run lint`
- `cd frontend && npm run build`
- `cd frontend && npm test`
- `cd frontend && npm audit --omit=dev --audit-level=high`

---

### Contributor License Agreement

By submitting this pull request I confirm that:

- [x] I have read and agree to the [Contributor License Agreement](../CLA.md).
- [x] My contribution is my own original work (or I have identified any
      third-party material and confirmed it is compatible with the CLA).
- [x] I have the right to submit this contribution under the terms of the CLA.
```

Create the PR against `origin/main`, verify its rendered body and CI status, and
do not merge or deploy before CI succeeds and a maintainer approves.

- [ ] **Step 4: Close Kata with concrete evidence**

Comment on `mailflow#4jyp` with the one-commit hash, PR URL, exact verification
commands/results, and any unavailable performance measurement. Set
`work.attention` and `work.attention_msg` truthfully, then close the issue only
after the implementation and PR are complete.
