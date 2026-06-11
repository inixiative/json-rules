# FEAT-001: Relative & Calendar Date Expressions

**Status**: ✅ Done (v2.6.0) — `check`, `toPrisma`, `toSql`
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-05-27
**Updated**: 2026-06-11
**Target**: v2.6.0

---

## Overview

Today relative date comparisons require the caller to pre-compute bounds and inject them via context, e.g.:

```ts
{ field: 'createdAt', dateOperator: 'after', path: 'thirtyDaysAgo' }
// caller must supply context.thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000)
```

This keeps rules pure but pushes ergonomics onto every host. For compliance and rule-authoring use cases ("within last 90 days," "this month," "before last month"), we want the relative expression to live in the rule itself while keeping the rule pure/serializable and the evaluator deterministic.

**Design finalized 2026-06-11** — see
[docs/plans/2026-06-11-date-and-window-primitives-design.md](../docs/plans/2026-06-11-date-and-window-primitives-design.md) (Part 1).
The open questions below are now resolved.

## Finalized shape

`DateRule.value` gains structured expressions. **Positive magnitudes only** —
direction lives in the keyword and operator, never in a sign. Units are dayjs
full words: `day/week/isoWeek/month/quarter/year/hour/minute/second`.

**Point** (with `before`/`after`/`onOrBefore`/`onOrAfter`, or `between` endpoints):
- `{ ago: { days: 30 } }`, `{ ahead: { months: 2 } }` — rolling
- `{ start: <period> }`, `{ end: <period> }` — named edge of a calendar period

**Range** (with new `within` operator):
- `{ this: 'month' }`, `{ last: 'week' }`, `{ next: 'quarter' }` — calendar period
- `{ ago: {…} }`, `{ ahead: {…} }` — rolling window `[now−Δ, now]` / `[now, now+Δ]`

Bare period + `before`/`after` ⇒ implied edge (`before`→start, `after`→end).

```ts
{ field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } }   // >30d ago
{ field: 'completedAt', dateOperator: 'within', value: { this: 'month' } }        // this month
{ field: 'completedAt', dateOperator: 'after',  value: { next: 'month' } }        // after next month
```

## Scope

- New `within` operator; `between`/`notBetween` keep two explicit points.
- `now` as an explicit context input the evaluator must be handed (no implicit
  `Date.now()`). Evaluator/compilers **throw if missing** when a relative/period
  expression is present.
- Units: day, week (→ isoWeek default), isoWeek, month, quarter, year, hour, minute, second.
- Compilers (Prisma, SQL) resolve to concrete bounds at compile time from `now`.
- Schema validation: unit words, positive magnitudes, operator↔value-shape pairing.

Out of scope:
- Field-relative offsets ("createdAt + 30d") — `from: { field, days }` forward-compat
  only; not implemented now.
- Calendar arithmetic edge cases (DST, leap seconds) — defer to dayjs; document the
  precision contract. (Note: `{ years: 1 }` is dayjs calendar arithmetic, NOT 365 days.)

## Tasks

- [ ] `operator.ts`: add `within`
- [ ] `types.ts`: point/range value-expression union on `DateRuleValue`
- [ ] `validate.ts`: units, positive magnitudes, operator↔shape pairing, `now` presence
- [ ] `check`/`date.ts`: resolve expressions against `now`; implement `within` + implied edges
- [ ] `toPrisma/date.ts`: resolve bounds at compile time from `options.context.now`
- [ ] `toSql/date.ts`: same (`date_trunc` + interval for periods)
- [ ] Tests:
  - [ ] before/after with `ago`/`ahead` point
  - [ ] `within` with rolling window and with `this`/`last`/`next` period
  - [ ] bare period implied-edge + explicit `start`/`end`
  - [ ] `between` with two relative points
  - [ ] missing `now` throws on all three paths
  - [ ] composes with `mapDefaults.where`
- [ ] README + operator catalog docs

## Resolved (was "Open Questions")

- **Shape**: object form, **not** ISO duration. Keyword carries direction.
- **Anchor**: always "now"; field-anchored offsets deferred (`from: { field }` reserved).
- **Sign convention**: no signs — positive magnitudes; direction via `ago`/`ahead`/
  `this`/`last`/`next` + operator.

## Configuration (resolved 2026-06-11)

`timeZone` / `weekStart` are **per-call options** on the existing options bags
(extend `CheckOptions` + Prisma/SQL options) — no global singleton, no helper.
Defaults: `timeZone: 'UTC'`, `weekStart: 'monday'` (ISO/isoWeek). Must compile into
all three targets identically. Plumbing: `checkDate` (and nesting paths) widened to
receive the date config, not just `context`. See design doc → Configuration.

## Still open

- Allow `start`/`end` on rolling `ago`/`ahead`? Lean: disallow (already points).

## Definition of Done

- [ ] Relative + calendar expressions authorable without caller pre-computation
- [ ] `now` contract documented; evaluator/compilers fail loud when missing
- [ ] `check`, `toPrisma`, `toSql` emit equivalent results for the same rule + `now`

## Related Tickets

- FEAT-003 (windowing selector — the other half of the driving fanMission rule)
