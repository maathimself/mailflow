# Body-search expression-index check

The English body predicate must match the `idx_messages_body` expression from
migration 0001. The previous `LEFT(..., 600000)` differed from the index.
The candidate changes only that English expression; PostgreSQL folds the existing
dictionary-selection CASE in the API's parameterized custom plan. This is a query-only change: no new index, migration,
write-path work, per-search memory setting, or extra query.

## Reproduce

Use a disposable PostgreSQL 16 database with `pg_trgm` installed (the normal
migrations install it). **Do not point the benchmark at a production database.**
All benchmark message rows and indexes are connection-local temporary objects;
the fixture contains invented text and example.test addresses only.

From `backend/`, with Node 22 and `npm ci` completed:

```sh
MAILFLOW_TEST_DATABASE_URL=postgres://... npm test -- --maxWorkers=2 \
  src/routes/search.bodyIndex.postgres.test.js \
  src/routes/search.stopWords.postgres.test.js
MAILFLOW_TEST_DATABASE_URL=postgres://... MAILFLOW_SEARCH_BENCHMARK=1 \
  npm test -- --maxWorkers=1 src/routes/search.bodyIndex.benchmark.postgres.test.js
```

The opt-in fixture has 60,000 messages over three accounts, about 8KB of body
text per row, the baseline body GIN, metadata GIN/trigram indexes, and date/account
indexes. Two accounts are searched. It prints EXPLAIN ANALYZE/BUFFERS JSON for the
baseline and actual candidate predicate, with a 12-second timeout, and compares
ordered IDs when both queries finish. This is not the full application schema or
a simulation of production cache/concurrency. A timeout is a censored result,
not a zero-second query. Timing assertions are deliberately absent.

## Preliminary measurements

Exploratory single runs on a shared development host, PostgreSQL 16.15, C/UTF8,
4MB work_mem. The initial prototype also used equivalent constant OR gates;
the final, smaller CASE-preserving version subsequently measured 4.3ms rare,
1.7ms absent, 35.0ms common and 3,613ms sender:

| Query, limit 50 | Baseline | Initial OR prototype | Final CASE candidate |
| --- | ---: | ---: | ---: |
| common body word | 37.3ms | 35.1ms | 35.0ms |
| rare body word | >12,000ms | 5.4ms | 4.3ms |
| absent body word | >12,000ms | 1.4ms | 1.7ms |
| metadata sender term | 3,949ms | 3,539ms | 3,613ms |

An independent PostgreSQL 18.6 run showed the same plan improvement (rare
>12,000ms to 1.7ms; common 48.4ms to 44.5ms). These are exploratory measurements,
not three-run medians or guarantees. The opt-in test above is the reproducible
source for an expanded benchmark before release.

A separate final-candidate long-body fixture (60 messages, common term, limit 20)
measured 3,327ms → 1,065ms for 600k-character bodies and 3,375ms → 1,911ms for
1.2M-character bodies at default planner settings. The baseline chose a sequential
scan and candidate a date-index scan. To isolate full-body evaluation cost, forcing
both onto the date path (`enable_seqscan=off`, `enable_bitmapscan=off`, synthetic
session only) changed the 1.2M case from 1,075ms to 1,909ms, a **1.78× regression**.
Those planner switches are diagnostics, not proposed production settings. Removing
the cap is a real tradeoff, not a free universal optimization.

## Correctness and limits

English matching now includes words after character 600,000, and no longer
manufactures a partial word at that boundary. The existing uncapped GIN already
rejects a stored English vector over PostgreSQL's size limit. Tests exercise that
write constraint and a long repetitive body accepted by the index. Stop-word
queries still use the existing capped simple-dictionary fallback, which has no
matching index. Scope, dictionary selection, stemming and null/negative behavior
are unchanged.

On the same C/UTF8 fixture, a Cyrillic query still selected a date-index scan
with per-row vectorization even after this change (EXPLAIN only). The patch is
therefore **not a fix for the reported Cyrillic search timeout**.

This does not fix Unicode case handling in a database initialized with C LC_CTYPE,
unfetched bodies, thread pagination, or all slow searches. In particular, a
negative query excluding a word in every message still needs to examine the whole
scope and can time out. Planner choices remain data/statistics dependent. Large
bodies can cost more to evaluate on a date-ordered common-term path because English
matching is no longer truncated. Test larger, varied-body and concurrent workloads
before claiming a general search-performance fix; see the tradeoffs discussed in
upstream PR #616.
