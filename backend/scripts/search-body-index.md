# Body search using the existing index

Search first materializes at most 256 newest visible messages after applying
account, folder and operator filters. Free-text predicates run on those stored
rows, so a different join plan cannot tokenize bodies outside the prefix. If
they contain a complete requested page, the query returns it without executing
any fallback producer. Otherwise, or when offset + limit exceeds 256, it uses
per-term materialized body-match IDs from `idx_messages_body`, joins them with
metadata matches, and finishes matching before sorting and pagination. Both
paths belong to one statement and see the same snapshot.

The fallback initializes each tsquery once to retain an indexable plan, guards
empty tsqueries, and uses LEFT JOINs instead of repeatedly scanned IN subplans.
Free-text searches use a transaction with `SET LOCAL work_mem='16MB'` to keep
large bitmaps exact at the tested size. This resets on commit or rollback;
operator-only searches keep the session default. Database timing metrics still
include the search statement. No functions, indexes, statistics, migrations or
write-path changes are added.

The full stored body is searchable, including text beyond the old 600,000-
character cap. Boundary truncation no longer invents lexemes. NULL bodies remain
empty text; the original body index's packed-vector limit on writes is unchanged.

## Reproduce

Use Node 22 and a disposable PostgreSQL database with `pg_trgm` installed.
Tests create connection-local temporary tables and indexes; they need no
CREATEDB permission and do not require a particular PostgreSQL major version.

```sh
cd backend
MAILFLOW_TEST_DATABASE_URL=postgresql://localhost/mailflow_test \
  npm test -- src/routes/search.test.js src/services/searchBodyIndex.postgres.test.js --maxWorkers=1

MAILFLOW_TEST_DATABASE_URL=postgresql://localhost/mailflow_test \
SEARCH_INDEX_BENCHMARK=1 \
SEARCH_INDEX_BENCHMARK_OUTPUT=/tmp/search-body-benchmark.json \
  npm test -- src/services/searchBodyIndex.postgres.test.js --maxWorkers=1
```

The opt-in benchmark loads 400,000 hydrated messages across three accounts.
The searched user's two accounts hold the older 266,666 messages; another user's
133,334 messages are newer. This deliberately tests the work needed to acquire a
scoped prefix, not just body evaluation. Inline bodies average 1,444 bytes,
keeping enough heap pages populated to stress bitmap memory. The fixture uses
the baseline schema, body/list/read indexes, stored metadata vector and trigram
indexes. It times two batches of the identical mark-all-read UPDATE on 5,000
hydrated rows, with three rolled-back executions per batch.

Captured SQL and EXPLAINs use the same transaction memory as the route. Tests
also call the actual route, check 4MB/2MB restoration after success and a SQL
error, and verify ordered IDs against the capped baseline wherever it completes.
Timed-out baseline cases are checked against independently generated expected
UIDs instead. Scope, operators, negation, hydration, cap boundaries, NULL dates,
insufficient prefixes and the 256/257 pagination boundary have separate tests.

## Measurements (2026-10-18)

PostgreSQL 16.15; 400,000 messages, 577,598,893 body bytes, 819,200,000 heap bytes.
Session `work_mem` was 4MB, `shared_buffers` 128MB, `temp_buffers` 8MB and
parallel query workers disabled. SQL timings were collected with a Node 26.12.0
harness; focused compatibility checks also run on the supported Node 22.23.3.
Median execution milliseconds across three EXPLAIN ANALYZE runs:

| Query | Baseline | Revised |
| --- | ---: | ---: |
| Rare (`lighthouse`, 39 table-wide hits) | timeout | 2,148 |
| Mid-frequency (`middlefrequency`, 5,000 hits) | 958 | 1,383 |
| Absent | timeout | 1,443 |
| Common (100%) | 282 | 376 |
| Common (53%) | 201 | 186 |
| Negative rare | 207 | 228 |
| Negative common (no results) | timeout | 3,339 |
| Sender match | 223 | 201 |
| Stopword (`or`) | timeout | 878 |
| Ten common terms, offset 257 | timeout | 19,954 |
| Common term in the oldest account | 384 | 593 |
| Common term with selective subject operator | 89 | 67 |

`timeout` means the baseline hit the production 30-second statement timeout;
it is not an estimated duration. All revised executions passed under that same
timeout. Actual route elapsed times ranged from 40ms to 21.8s; the ten-term deep
page was the slowest. Every tested revised bitmap had zero lossy heap blocks.
Common, 53%-common, negative-rare and sender pages bypassed the full body-match
collection. Some cases are slower than baseline: the bounded prefix and full
fallback have overhead, and this is not a universal speedup.

With a 2MB incoming session setting, revised common, 53%-common and negative-
common queries took 338ms, 304ms and 4,034ms respectively, again without lossy
blocks. A ten-term first page with sixteen 264KB bodies took 10.7s and skipped
the fallback. The prefix bounds rows, not body bytes or the work of finding
scoped candidates.

The ten-term fallback used ten in-memory sorts of about 14.1MiB each, plus CTE
storage and other operators; its plan wrote about 118MiB of temporary blocks.
Its one small hash used 9KiB and one batch. **16MB is a per-operation setting,
not a per-request memory ceiling.** Twenty similarly planned concurrent searches
could consume about 2.8GiB in those sorts alone, plus CTEs and other allocations.
No concurrent load test was run. Larger tables can still outgrow this bitmap
budget; the fixture establishes a measured envelope, not an unlimited-size
guarantee. Existing session settings above 16MB are also overridden inside the
free-text transaction.

Mark-all-read medians were 2,782ms and 2,649ms for the two identical 5,000-row
batches. There is no new index or write code to switch between them. Repeated
rolled-back writes, dead index entries and shared-host load make their difference
unsuitable for attributing a write regression or improvement. Added upgrade and
index-build work is zero.

Temporary relations use session-local buffers, so these results do not validate
production cache behavior at 128MB shared_buffers. They omit production WAL and
commit costs and cannot use parallel scans. Runs follow loading and ANALYZE,
are not cold-cache measurements, and ran on a shared host. The JSON report
retains plans, buffer counts, memory settings, expected UIDs and route timings.

## Earlier unmerged checkouts

Migrations 0067/0068 were only part of this unmerged PR and are removed here.
If you tested an earlier checkout against a persistent database, remove its
experimental objects before comparing write costs (normal installs never had
them). Run these statements separately, outside a transaction:

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_search;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_search_overflow;
DROP STATISTICS IF EXISTS stats_messages_body_search;
DROP FUNCTION IF EXISTS mailflow_body_search_vector(text);
DROP FUNCTION IF EXISTS mailflow_body_overflow_matches(text, text);
```

Keep the original `idx_messages_body`. There is no production upgrade migration.
