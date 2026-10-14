# Stored-body search index: PostgreSQL 16 verification

The route still searches stored bodies using English stemming and the first
600,000 characters, alongside sender/subject substrings and the existing snippet
vector. Account/folder/trash filters, date order, negation and pagination remain
in the route. This adds no body downloading or ranking.

A direct expression index is unsafe: a capped vector can exceed PostgreSQL's
1 MB packed limit even when the complete body fits the existing uncapped index.
The named regression generates 73,750 distinct Unicode words, an earlier q100
word, padding, and another q100 ending at character 600,025. At character
600,000 the final word becomes a new q75 lexeme. The full vector uses 1,048,520
packed bytes; the capped vector needs 1,048,600 and raises SQLSTATE 54000.

The indexed helper returns the exact current vector, or NULL for that error.
An account-scoped overflow index permits the rare fallback to join BitmapOr.
The fallback tests the same capped, normalized tokens without packing a vector;
its equivalence covers stock English dictionaries. Customized thesaurus/filter
configurations are outside this proof. Existing indexes are retained, including
the uncapped index's pre-existing ingestion limits.

Expression statistics are initialized during migration. Partial expression index
statistics alone caused a common term to be estimated at 375 of 75,000 rows,
choosing a full bitmap/sort and taking about 13 seconds. Explicit statistics
restore the date-index LIMIT plan. Empty tsqueries skip body evaluation; metadata
substring matches still apply.

## Reproduce

Use Node 22 and an explicitly supplied disposable PostgreSQL 16 server. Set
`SEARCH_INDEX_TEST_URL` to its URL with a role that has CREATEDB. The tests run
the complete migration history in a randomly named database and drop it afterward.

```sh
cd backend
GOMAXPROCS=2 GOFLAGS=-p=2 npm test -- src/services/searchBodyIndex.integration.test.js src/routes/search.test.js --maxWorkers=2
SEARCH_INDEX_BENCHMARK=1 SEARCH_INDEX_BENCHMARK_OUTPUT=/tmp/search-body-index.json GOMAXPROCS=2 GOFLAGS=-p=2 npm test -- src/services/searchBodyIndex.integration.test.js --maxWorkers=1
```

The JSON contains four EXPLAIN (ANALYZE, BUFFERS) plans per query: first observed
run plus three warm runs, ordered IDs, index sizes, migration time and writes.
`SEARCH_INDEX_BASELINE_REPORT` can reuse an unchanged fixture's prior baseline
timings on the same PostgreSQL version; fresh control queries still verify IDs.
Omit it after changing fixtures or baseline SQL. Tests impose no elapsed-time CI
thresholds. Routine tests skip the PostgreSQL suite unless its URL is supplied.

## Synthetic results

PostgreSQL 16.15, 75,000 varied messages plus small regression fixtures, three
accounts and multiple folders, all current schema/index migrations applied.
Bodies range from roughly 1–4 KB to occasional 20 KB and 200 KB. Parallel query
workers are disabled to stay within the local host resource budget. This was a
shared local host: times are indicative, and
loading, builds and ANALYZE warm caches. First observed runs are not cold-cache
measurements. The unchanged baseline timing plans were retained from the initial
run; corrected indexed plans and fresh ordered-ID parity were rerun.

Execution milliseconds: first observed / median of three warm runs.

| Query | Before | Indexed | Returned rows |
| --- | ---: | ---: | ---: |
| Selective body term (`lighthouse`) | 15,291.9 / 15,499.0 | 66.7 / 54.5 | 16 |
| Common body term (`ordinary`) | 50.5 / 38.8 | 49.4 / 48.5 | 50 |
| Two-character stopword (`or`) | 13,934.2 / 13,242.1 | 94.8 / 71.1 | 8 |
| Absent term | 14,073.6 / 15,793.9 | 3.0 / 3.0 | 0 |
| Negative-only term | 14,768.5 / 16,034.8 | 20,369.3 / 22,570.5 | 1 |

Selective and absent terms use BitmapOr with the new GIN index. The common term
uses the existing date index. The stopword case contains no body-vector
calculation. Negative-only search remains slower; other broad nonempty queries
can still scan and re-evaluate vectors. The two-character measurement is a
stopword case, not a claim about every short substring.
The exception-handling helper is parallel unsafe, so production broad scans can
also lose parallelism compared with the original expression.

The two indexes occupy 4,800,512 bytes and 8,192 bytes. The measured index
migration plus initial statistics analysis took 191.7 seconds. The migration runner
waits before listening, so this is additional upgrade startup time. Concurrent
builds avoid prolonged write-blocking table locks; they still cost CPU and I/O.

Write statement milliseconds, median of three rolled-back runs; commit latency
is excluded. Both phases keep the existing indexes. Added vector computation
increases write cost.

| Operation | Rows | Before | Indexed |
| --- | ---: | ---: | ---: |
| Insert | 500 | 212.6 | 700.0 |
| Body cache update | 500 | 244.3 | 735.3 |
| Read flag update | 166 | 84.5 | 186.3 |

Regressions cover normal/NULL/multilingual bodies, cap boundaries, the ingestible
packed-overflow counterexample, operators and account visibility, trash,
negation/pagination, hydration/replacement/removal, invalid concurrent-index
retry, valid builds before bookkeeping, and correctness after dropping only the
new indexes. The SQL helpers remain installed during that index rollback.
