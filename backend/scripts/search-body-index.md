# Body search using the existing index

Search first checks the newest 256 scoped rows. A complete page skips the
selectivity checks and fallback, in the same statement and snapshot. Otherwise,
each positive term collects at most T unique IDs from separately capped body
and metadata arms, including account scope and is_deleted=false. Sender,
subject and search_vector matches count too. Below T, the count is exact.

The smallest selective positive term drives primary-key lookups; other terms
run directly on those rows. All-broad and negative-only searches use a fenced
date scan with direct predicates and an offset + limit bound before account
enrichment. This keeps hash joins from forcing full body evaluation. Negative
match sets are never materialized. Empty tsqueries skip body evaluation.

T = min(4096, 4 * (offset + limit)); the named constants sit beside
RECENT_PREFIX_ROWS. There is no transaction or work_mem override. Session
work_mem remains per operation. Capped IDs bound storage, not GIN's table-wide
bitmap construction; a scoped count can still recheck many rows when matches
in the searched accounts are sparse. No schema, index, extension, stored-vector
or write-path changes are added. Full bodies beyond the former 600k cap remain
searchable, with NULL bodies treated as empty text.

## Reproduce

Use Node 22 and a disposable PostgreSQL database with pg_trgm installed:

```sh
cd backend
MAILFLOW_TEST_DATABASE_URL=postgresql://localhost/mailflow_test \
  npm test -- src/routes/search.test.js src/routes/search.unifiedInbox.test.js src/services/searchBodyIndex.postgres.test.js --maxWorkers=1
MAILFLOW_TEST_DATABASE_URL=postgresql://localhost/mailflow_test \
SEARCH_INDEX_BENCHMARK=1 SEARCH_INDEX_BENCHMARK_OUTPUT=/tmp/search-body-benchmark.json \
  npm test -- src/services/searchBodyIndex.postgres.test.js --maxWorkers=1 -t 'benchmarks 400k'
```

Set SEARCH_INDEX_CALIBRATION=1 to compare multipliers 1, 4 and 16 (capped at
4096), at limit 200 / offset 250. Mid-frequency searches the oldest account.

## Measurements (2026-10-19)

PostgreSQL 16.15, Node 22.23.3; 400,000 synthetic messages, 577,598,893 body bytes,
819,200,000 heap bytes. Searched accounts own the older 266,666 rows; another
account owns the newer 133,334. shared_buffers=128MB, temp_buffers=8MB; no parallel
workers. Times and temp-write bytes are three-run medians; lossy blocks are the
maximum. Temp bytes = EXPLAIN Temp Written Blocks * 8192. ≥30,000 is a censored
median: at least two runs hit the production timeout. Other metrics require
three completed plans. Main retains its unconditional 600k-capped body predicate;
revised uses the stated session budget. Completed results match generated UIDs.
The three partially completed main cases returned the expected empty results.
PG fixtures cover scope, operators, NULL dates, negation, hydration, full-body
boundaries, threshold deduplication, probe bypass and adverse planner settings.

2MB pagination matrix:

| Search | Limit / offset | Main ms | Revised ms | Temp bytes main / revised | Lossy blocks main / revised |
| --- | --- | ---: | ---: | ---: | ---: |
| 100% | 200 / 0 | 150 | 146 | 0 / 0 | 0 / 0 |
| 53% | 200 / 0 | 173 | 387 | 0 / 0 | 0 / 166 |
| 100% + rare | 200 / 0 | ≥30,000 | 456 | — / 0 | — / 200 |
| NOT rare | 200 / 0 | 165 | 192 | 0 / 0 | 0 / 0 |
| NOT 53% | 200 / 0 | 149 | 291 | 0 / 0 | 0 / 0 |
| NOT 100% | 200 / 0 | ≥30,000 | ≥30,000 | — / — | — / — |
| Rare | 200 / 0 | ≥30,000 | 264 | — / 0 | — / 0 |
| Absent | 200 / 0 | ≥30,000 | 526 | — / 0 | — / 0 |
| 100% | 50 / 250 | 415 | 713 | 0 / 0 | 0 / 300 |
| 53% | 50 / 250 | 455 | 730 | 0 / 0 | 0 / 252 |
| 100% + rare | 50 / 250 | ≥30,000 | 206 | — / 0 | — / 300 |
| NOT rare | 50 / 250 | 132 | 184 | 0 / 0 | 0 / 0 |
| NOT 53% | 50 / 250 | 194 | 224 | 0 / 0 | 0 / 0 |
| NOT 100% | 50 / 250 | ≥30,000 | ≥30,000 | — / — | — / — |
| Rare | 50 / 250 | ≥30,000 | 31 | — / 0 | — / 0 |
| Absent | 50 / 250 | ≥30,000 | 27 | — / 0 | — / 0 |
| 100% | 200 / 250 | 180 | 510 | 0 / 0 | 0 / 450 |
| 53% | 200 / 250 | 379 | 640 | 0 / 0 | 0 / 387 |
| 100% + rare | 200 / 250 | ≥30,000 | 295 | — / 0 | — / 450 |
| NOT rare | 200 / 250 | 172 | 142 | 0 / 0 | 0 / 0 |
| NOT 53% | 200 / 250 | 236 | 242 | 0 / 0 | 0 / 0 |
| NOT 100% | 200 / 250 | ≥30,000 | ≥30,000 | — / — | — / — |
| Rare | 200 / 250 | ≥30,000 | 18 | — / 0 | — / 0 |
| Absent | 200 / 250 | ≥30,000 | 25 | — / 0 | — / 0 |

4MB continuity, using the cases from the previous PR table:

| Search | Limit / offset | Main ms | Revised ms | Temp bytes main / revised | Lossy blocks main / revised |
| --- | --- | ---: | ---: | ---: | ---: |
| Rare | 50 / 0 | ≥30,000 | 246 | — / 0 | — / 0 |
| Mid-frequency | 50 / 0 | 777 | 845 | 0 / 0 | 0 / 0 |
| Absent | 50 / 0 | ≥30,000 | 228 | — / 0 | — / 0 |
| 100% | 50 / 0 | 132 | 126 | 0 / 0 | 0 / 0 |
| 53% | 50 / 0 | 102 | 127 | 0 / 0 | 0 / 0 |
| NOT rare | 50 / 0 | 228 | 146 | 0 / 0 | 0 / 0 |
| NOT 100% | 50 / 0 | ≥30,000 | ≥30,000 | — / — | — / — |
| Sender | 50 / 0 | 147 | 162 | 0 / 0 | 0 / 0 |
| Stopword | 50 / 0 | ≥30,000 | 546 | — / 0 | — / 0 |
| Ten common, offset 257 | 50 / 257 | ≥30,000 | 2,015 | — / 0 | — / 2500 |
| 100%, oldest account | 50 / 0 | 203 | 225 | 0 / 0 | 0 / 0 |
| 100%, subject operator | 50 / 0 | 50 | 40 | 0 / 0 | 0 / 0 |

Threshold calibration at 2MB:

| T multiplier | 53% ms | Mid-frequency in oldest account ms |
| --- | ---: | ---: |
| 1 | 295 | 4,158 |
| 4 | 370 | 565 |
| 16 | 613 | 589 |

At limit 200 / offset 250, T=450 leaves the 1,666-hit oldest-account term on
the date path (4,158ms); T=1,800 uses its exact ID set (565ms). Increasing T to
4,096 makes 53% slower (613ms versus 370ms at T=1,800). Four page rows is the
measured compromise; the 4,096 ceiling keeps large offsets from growing the ID
materialization indefinitely.

Every measured case slower than main (main → revised milliseconds):

- 4MB: mid-frequency 777 → 845; 53% 102 → 127; sender 147 → 162; oldest account 203 → 225.
- 2MB, 200 / 0: 53% 173 → 387; NOT rare 165 → 192; NOT 53% 149 → 291.
- 2MB, 50 / 250: 100% 415 → 713; 53% 455 → 730; NOT rare 132 → 184; NOT 53% 194 → 224.
- 2MB, 200 / 250: 100% 180 → 510; 53% 379 → 640; NOT 53% 236 → 242.

Broad fallbacks pay for the capped check. Insufficient probes duplicate body
work for 53% and NOT 53% at limit 200 / offset 0. Complete probes evaluate a
fixed 256 rows; selective checks add work for mid-frequency. Direct negative
deep pages include bounded sorting/enrichment and shared-host timing variation.
NOT 100% exceeds 30 seconds on both plans at every measured pagination setting.
Without a selective positive driver, its near-empty complement requires a full
body scan; this change supplies no bounded solution for that case.

These are warm temporary-table measurements on a shared host. They omit
production WAL/commit costs, cold-cache behavior and concurrent-load testing;
absolute timings vary. Identical 5,000-row rolled-back write batches took 1,304ms and 1,013ms; these are not before/after schemas.

## Earlier unmerged checkouts

If you tested the removed 0067/0068 experiments, run these statements separately
outside a transaction. Normal installs never had these objects. Keep the
original idx_messages_body; there is no production upgrade migration.

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_search;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_search_overflow;
DROP STATISTICS IF EXISTS stats_messages_body_search;
DROP FUNCTION IF EXISTS mailflow_body_search_vector(text);
DROP FUNCTION IF EXISTS mailflow_body_overflow_matches(text, text);
```
