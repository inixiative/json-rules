# FEAT-003: Windowing Selector (orderBy / take / skip)

**Status**: ✅ Done (v2.6.0) — `check()` full; `toPrisma` extremal rewrite; `toSql` rejects
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-06-11
**Updated**: 2026-06-11
**Target**: v2.6.0

---

## Overview

Add ordered selection to `ArrayRule` / `AggregateRule` so a rule can predicate
against the **first/last N** elements of a relation or array. Driving case:

> _"user whose **last fanMission** was more than 30 days ago"_
> → order `fanMissions` by `completedAt` desc, `take: 1`, then assert that element
> is `before { ago: { days: 30 } }`.

Design: [docs/plans/2026-06-11-date-and-window-primitives-design.md](../docs/plans/2026-06-11-date-and-window-primitives-design.md) (Part 2).

## Shape

Flat keys on the array/aggregate rule, alongside the predicate:

```ts
{
  field: 'fanMissions',
  orderBy: [{ field: 'completedAt', dir: 'desc' }],
  take: 1,        // optional, positive — count from front of ordered list
  skip: 0,        // optional, positive offset
  arrayOperator: 'all',
  condition: { field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } },
}
```

- Pipeline: **order → skip → take** → sub-array → existing predicate evaluates it.
- Direction lives in `orderBy.dir` — **no `first`/`last` keyword** (`last` collides
  with the date period vocabulary; `take`/`skip` is Prisma's own language).
- `orderBy` is multi-key, maps 1:1 onto Prisma `orderBy` / SQL `ORDER BY` / lodash.

## Empty-window semantics

No engine default. Author expresses intent via the array operator:
- `all` → vacuously true on empty window
- `atLeast: 1` / `any` → false on empty window
- "exists AND matches" = `all` AND `notEmpty`.

## Scope

- `check()` — full support, all window shapes. ✅ Shipped in v2.6.0.
- `toPrisma` — **extremal rewrite** shipped: `take: 1` + single `orderBy` on the
  compared field + monotonic op + aligned direction rewrites to `every`/`some`
  (max/min is the binding element). All other windowed rules throw "unsupported".
- `toSql` — windowing always rejected (no relation existential subqueries in a
  WHERE fragment).

## Tasks

- [ ] Types: `orderBy`/`take`/`skip` on `ArrayRule` + `AggregateRule`; `OrderBy` type
- [ ] Validator: positive `take`/`skip`, `orderBy` field shape, backend gating
- [ ] `check`: order → skip → take pipeline feeding existing array/aggregate eval
- [ ] `toPrisma`: extremal rewrite (`none`/`some`); throw on general N/skip
- [ ] `toSql`: extremal rewrite; throw on general N/skip
- [ ] Tests:
  - [ ] take:1 desc + `all` before relative bound (the fanMission case) on all 3 paths
  - [ ] empty window under `all` vs `atLeast:1`
  - [ ] multi-key orderBy
  - [ ] general take:N / skip → check works, Prisma/SQL throw
  - [ ] aggregate over a window (e.g. sum of last 3) in `check`
- [ ] README + support matrix

## Open Questions

- Aggregate-over-window in SQL: `sum` of `take: N` needs a windowed subquery — likely
  `check()`-only initially; confirm.
- `orderBy` on a relation in Prisma extremal rewrite — the rewrite sidesteps ordering
  (it becomes none/some), so `orderBy` is only *semantically* needed for non-extremal
  (check-only) cases. Document that `orderBy` is ignored by the extremal rewrite.

## Definition of Done

- [ ] Windowing authorable on array/aggregate rules
- [ ] `check` full; extremal compiles to Prisma/SQL; non-extremal throws clearly
- [ ] Driving fanMission rule passes on all three targets

## Related Tickets

- FEAT-001 (relative date expressions — the date half of the same driving rule)
