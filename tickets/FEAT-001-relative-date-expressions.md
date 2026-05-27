# FEAT-001: Relative Date Expressions

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: Medium
**Created**: 2026-05-27
**Updated**: 2026-05-27

---

## Overview

Today relative date comparisons require the caller to pre-compute bounds and inject them via context, e.g.:

```ts
{ field: 'createdAt', dateOperator: 'after', path: 'thirtyDaysAgo' }
// caller must supply context.thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000)
```

This keeps rules pure but pushes ergonomics onto every host. For compliance and rule-authoring use cases ("within last 90 days," "since fiscal year start," "in the past 12 months"), we want the relative expression to live in the rule itself while keeping the rule pure/serializable and the evaluator deterministic.

## Scope

- Shape for relative expressions in `DateRule` (e.g. `{ relative: { days: -30 } }`)
- "Now" as an explicit context input the evaluator must be handed (no implicit `Date.now()` inside the library)
- Multiple units: days, hours, minutes, months, years (consider ISO 8601 duration strings)
- Compatible with `between`/`notBetween` ranges (relative range, not just relative point)
- Schema validation continues to work
- Compilers (Prisma, SQL) emit correct WHERE/predicates against the resolved bounds

Out of scope:

- Field-relative offsets (e.g. "createdAt + 30d") — separate concern.
- Calendar arithmetic edge cases (DST, leap seconds) — defer to whatever the chosen runtime gives us; document the precision contract.

## Tasks

- [ ] Spec relative-expression shape and pick syntax (object form vs. ISO duration string)
- [ ] Define `now` context contract — required input when any relative expression is used; evaluator throws if missing
- [ ] Extend `DateRule` types + validator
- [ ] Implement in-memory `checkDate` resolution
- [ ] Implement in `toPrisma/date.ts` (resolve at compile time using `options.context.now`)
- [ ] Implement in `toSql/date.ts` (same)
- [ ] Tests:
  - [ ] before/after with relative bound
  - [ ] between with relative range (e.g. last 30 days inclusive)
  - [ ] missing `now` throws
  - [ ] composes with `mapDefaults.where`
- [ ] Document in README.md and operator catalog docs

## Open Questions

- Shape: `{ relative: { days: -30 } }` vs. `{ relative: 'P-30D' }` (ISO 8601)? Object form is easier to validate and emit; ISO is terser and standard.
- Anchor: always "now," or allow `{ relativeTo: 'fieldName' }` for field-anchored offsets? Defer the latter unless asked.
- Negative vs. positive convention: `days: -30` (math-style offset from now) vs. `daysAgo: 30` (English-style). Object form makes both readable; pick one.

## Definition of Done

- [ ] Relative expression authorable in a rule without caller pre-computation
- [ ] `now` contract documented; evaluator/compilers fail loud when missing
- [ ] All three execution paths (`check`, `toPrisma`, `toSql`) emit equivalent results for the same rule + `now`

## Related Tickets

- (none yet)
