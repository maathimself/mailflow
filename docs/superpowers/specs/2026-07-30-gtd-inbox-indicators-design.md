---
last_edited: 2026-07-30
---

# GTD Toast and Inbox Indicators

## Goal

Make GTD classification visible at the moment it is applied and while the
message remains in the inbox, using the same colors and waiting-age treatment
as the existing GTD surfaces.

## Scope

- Color the icon and applied-state text in successful “Label applied” toasts.
- Show GTD indicators immediately before the date in normal inbox rows.
- Support Todo, Watch, Delegated, Reference, and Someday.
- Support account and unified inboxes, flat and threaded views, and multiple
  labels on one thread.
- Reuse the current GTD colors, translations, aging calculation, and stale
  threshold.

Search results, non-inbox folders, expanded thread sub-rows, and changes to GTD
classification behavior are out of scope.

## User Interface

Successful classification toasts retain their existing structure and envelope
icon. The icon foreground and background use the applied state’s canonical GTD
color, and the state name below “Label applied” uses the same foreground color.
Failure and non-GTD notifications retain their current appearance.

Inbox indicators appear in the row’s right-side metadata cluster immediately
before the date:

| State | Indicator |
| --- | --- |
| Todo | Blue “Todo” chip |
| Watch | Yellow aging chip, such as `⏱ 2d` |
| Delegated | Orange aging chip, such as `⏱ 2d` |
| Reference | Purple “Reference” chip |
| Someday | Neutral gray “Someday” chip |

Waiting chips reuse the GTD sidebar’s red stale treatment after the existing
14-day threshold. Threads with multiple labels show all indicators in canonical
order: Todo, Watch, Delegated, Reference, Someday.

## Data Flow

The existing inbox request remains the only request needed to render the list.
The backend first resolves the requested page, then performs one batched,
indexed lookup for GTD-folder copies belonging to only those page threads.

Each inbox row gains:

- `gtd_states`: an ordered array of matching state keys.
- `gtd_dates`: a small state-to-date map so Watch and Delegated retain their
  own correct ages when both labels are present.
- `gtd_date`: the newest matching copy date, retained as a defensive fallback.

The lookup respects each account’s `gtd_enabled` flag and custom GTD folder
mapping. It works across account and unified inboxes and returns empty metadata
when GTD is disabled or no label copy exists.

This avoids a second network round trip and avoids relying on the separately
loaded GTD sections feed, whose visible rows are capped at 50 per state.

## Components

- The message-list service enriches the already-paged flat and threaded inbox
  results with GTD metadata.
- A pure frontend helper normalizes state order and creates display descriptors
  from `gtd_states`, `gtd_dates`, translations, and the existing aging helpers.
- A small shared inbox indicator component renders those descriptors in both
  top-level row variants.
- Successful classification notifications include `gtdState`.
- The toast appearance resolver maps optional `gtdState` metadata through the
  existing `GTD_COLORS` and `GTD_CHIP_BG` constants.

No new dependency, endpoint, persistent column, or migration is required.

## Performance

The GTD lookup runs only after inbox pagination and only for the page’s distinct
account/thread pairs. Existing indexes on `(account_id, folder, thread_key,
date)` and `(account_id, thread_key)` cover the lookup. The response adds only a
small state array and a date map with at most five entries per row.

Verification will compare the relevant query plan and timing before and after
the enrichment where a local database is available. Automated service tests
will ensure the lookup remains batched rather than becoming an N+1 query.

## Error Handling

Inbox loading keeps its current failure behavior. A missing or malformed GTD
metadata value is treated as no indicator, so it cannot break message-row
rendering. Classification failures do not receive success-state coloring and
continue through the existing failure notification path.

## Testing

- Backend tests cover disabled GTD, custom folder mappings, multiple labels,
  unified-account separation, ordered states, and per-state aging dates.
- Frontend helper tests cover canonical ordering, text versus aging indicators,
  missing dates, and stale waiting chips.
- Classification tests assert that only successful classification notifications
  carry `gtdState`.
- Toast appearance tests assert canonical foreground/background colors and
  unchanged defaults for unrelated notifications.
- Existing frontend and backend suites, lint, and production builds must pass.

## Delivery

The work is tracked in Kata issue `mailflow#4jyp`. The branch will contain one
Conventional Commit before push. The pull request will target `main`, fully
complete the repository template, include the required CLA confirmations, and
wait for CI and maintainer review before merge or production release.
