# FEAT-002: Evaluator Targets Beyond Prisma

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-05-27
**Updated**: 2026-05-27

---

## Overview

The library currently supports three execution paths:

- `check` — in-memory JS evaluation against plain objects
- `toPrisma` — Prisma `WhereInput` compiler
- `toSql` — generic SQL compiler

A rule is, structurally, a typed predicate over schema-described data. That same predicate should be runnable against more data sources without forking rule shapes per backend. Compliance, analytics, and event-processing use cases all need targets other than Prisma.

## Scope

Audit and extend evaluator coverage for:

- **Warehouse SQL dialects**: DuckDB, BigQuery, Snowflake. Likely a small delta off existing `toSql` if dialect-specific differences (date functions, parameter syntax, identifier quoting) are pluggable.
- **Event streams / nested JSON documents**: confirm `check` already handles these via path walking; document the contract and close any gaps (e.g. `$.path` semantics, missing-field behavior under aggregates).
- **Document-extracted data** (compliance use case — parsed PDFs, KYC docs, etc.): likely served by `check` once the data is shaped into objects; verify and document.

Out of scope:

- MongoDB query compiler (defer until asked — different query model, larger surface).
- GraphQL filter compilers (host-specific).
- Stream processors (Flink, Kafka Streams) — host integrates `check`.

## Tasks

- [ ] Audit `toSql` for dialect assumptions (parameter syntax `$1` vs. `?` vs. `@p1`, identifier quoting, date functions like `EXTRACT(DOW)`)
- [ ] Decide whether to introduce a pluggable `SqlDialect` adapter or fork per dialect
- [ ] Prototype DuckDB target (smallest delta — Postgres-ish dialect, runs locally, useful for compliance backtesting)
- [ ] Spec BigQuery target (different param syntax, different date functions)
- [ ] Audit `check` against event-stream and nested-JSON use cases; document supported shapes
- [ ] Tests for each new dialect mirroring the existing `toSql` test surface
- [ ] Document execution-target matrix in README.md (which rule features work on which backend)

## Open Questions

- Pluggable dialect vs. forked compiler: pluggable is cleaner long-term but ANSI-SQL coverage may already be 80% there; investigate before committing.
- Where does dialect selection live — `toSql(rule, { dialect: 'duckdb' })` or separate entry points like `toDuckdb`?
- Feature parity: should every operator be supported on every backend, or do we accept "this operator is not available on dialect X" with a clear error?

## Definition of Done

- [ ] At least one additional SQL dialect shipped end-to-end with test coverage matching `toSql`
- [ ] Execution-target matrix documented (operator × backend)
- [ ] `check` coverage for event/document shapes confirmed and documented; gaps either filed or fixed

## Related Tickets

- (none yet)
