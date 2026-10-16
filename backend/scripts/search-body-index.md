# Body search using the baseline index

Body matching uses the existing `idx_messages_body` GIN index over
`to_tsvector('english', coalesce(body_text,''))`. A per-term materialized CTE
returns body-match IDs; LEFT JOINs let large sets use hash/merge joins even when
they exceed work_mem. The outer search combines them with sender, subject and
stored metadata matches, applies scope/operators, and sorts/paginates as before.
A second materialization fence finishes matching before ordering and LIMIT,
preventing date-driven nested-loop rescans for broad exclusions. This keeps an
outer date-index scan from evaluating body
vectors for each visited row. An InitPlan computes each body tsquery once and
keeps common-term statistics from choosing a body-tokenizing sequential scan.
An empty-query guard skips body matching altogether for stopwords. No planner switches or inflated function costs are
needed. This branch adds no functions, indexes, statistics or migrations.

The full stored body is searchable. Text after the former 600,000-character cap
now matches, and truncating a word at that boundary no longer creates a synthetic
lexeme. NULL bodies still behave as empty text. The baseline index's existing
packed-vector limit on writes is unchanged.

## Reproduce

Use a disposable PostgreSQL database with `pg_trgm` already installed. Tests use
connection-local temporary tables and indexes and require no CREATEDB privilege.
They do not require a particular PostgreSQL major version.

```sh
cd backend
MAILFLOW_TEST_DATABASE_URL=postgresql://localhost/mailflow_test \
  npm test -- src/routes/search.test.js src/services/searchBodyIndex.postgres.test.js --maxWorkers=1

MAILFLOW_TEST_DATABASE_URL=postgresql://localhost/mailflow_test \
SEARCH_INDEX_BENCHMARK=1 \
SEARCH_INDEX_BENCHMARK_OUTPUT=/tmp/search-body-benchmark.json \
  npm test -- src/services/searchBodyIndex.postgres.test.js --maxWorkers=1
```

The opt-in benchmark loads 200,000 hydrated messages, compares the actual route
SQL against the old capped body arm, and checks ordered-ID parity. It measures
rare, 5,000-hit, absent, common, negative and stopword terms. It also times the
mark-all-read UPDATE on a 5,000-message folder, 500 inserts and 500 body updates.
Both write phases use the same schema: the revision changes only SELECTs.

The fixture uses the baseline messages/accounts schema and existing body, list,
read-flag, metadata-vector and trigram indexes. Temporary tables avoid touching
application data but omit production WAL/commit costs and cannot use parallel
scans. This is a controlled SQL comparison, not a prediction for a real mailbox.
First observations follow loading and ANALYZE, so they are not cold-cache runs.

## Measurements (2026-10-16)

PostgreSQL 16.15, Node 22.23.3; 200,000 hydrated messages and 906,752,353
uncompressed body bytes. Median execution milliseconds across three EXPLAIN
ANALYZE runs:

| Query | Body hits | Baseline | Revised |
| --- | ---: | ---: | ---: |
| Rare (`lighthouse`) | 19 | 70,041 | 172 |
| Mid-frequency (`middlefrequency`) | 5,000 | 674 | 162 |
| Absent (`unfindabletoken`) | 0 | 88,749 | 138 |
| Common (`ordinary`) | 200,000 | — | 846 |
| Negative rare (`-lighthouse`) | — | — | 716 |
| Negative common (`-ordinary`) | — | — | 515 |
| Stopword (`or`) | 0 | — | 168 |

The first three queries use `idx_messages_body` in the revised plans. The
complete-match fence also prevents the broad negative query from repeatedly
scanning a materialized body-ID set. All revised queries and writes passed with
the production 30-second statement timeout. Baseline queries ran without that
timeout so their cost could be measured. Baseline timing triples were retained
from the earlier run on the same deterministic fixture; ordered UID results had
been compared directly with baseline and were checked again in the final run.
Only revised timings were collected for the four extra broad/negative/stopword
cases. Materializing all matches trades early-exit opportunities for avoiding
body re-tokenization and repeated match-set scans.

Write statement milliseconds, median of three rolled-back executions per batch;
COMMIT latency is excluded:

| Operation | Rows | First batch | Second batch |
| --- | ---: | ---: | ---: |
| Mark all read | 5,000 | 2,499 | 2,665 |
| Insert hydrated messages | 500 | 191 | 348 |
| Replace cached bodies | 500 | 249 | 320 |

Both batches use **identical SQL and schema**: this revision changes SELECTs only.
The harness labels them baseline/revised for comparison, but there is no new
index or write code to switch between them. Sequential repeated writes (including
dead index entries from rollbacks) and shared-host load make the timing difference
unsuitable for attributing a regression or improvement to this revision.
ANALYZE took 12.4 seconds; this branch adds no statistics collection. Added
migration/index-build time is zero.

For query-only iteration, `SEARCH_INDEX_BASELINE_REPORT=/path/to/previous.json`
can reuse baseline timings and verified ordered UIDs from this same fixture.
The harness checks PostgreSQL version, message count and body byte count; use
this only with the unchanged fixture on the same test host. Omit it for a fresh
baseline comparison.

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
