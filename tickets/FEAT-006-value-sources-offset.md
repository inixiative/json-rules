# FEAT-006: One value-source reader; `offset` on path and bind; path-valued magnitudes

**Status**: 🟡 In progress — PR #18 (`date-rule-bind`)
**Linear**: ZLT-5217 (offset on path comparisons, numbers and dates)
**Priority**: Medium
**Created**: 2026-10-06
**Target**: 2.27.0

First consumer: Zealot platform alerts (userevidence/Zealot-Monorepo#2656). The incident
lifecycle is a `@inixiative/transitions` map, and its auto-resolve guard reads the rule's own
window off a related row:

```ts
{ all: [
  { field: 'lastBreachedAt', dateOperator: 'before',
    value: { ago: { seconds: { path: '$.platformAlertRule.autoResolveAfterSeconds' } } } },
  { any: [
    { field: 'lastIndeterminateAt', operator: 'isEmpty' },
    { field: 'lastIndeterminateAt', dateOperator: 'before',
      value: { ago: { seconds: { path: '$.platformAlertRule.autoResolveAfterSeconds' } } } },
  ] },
] }
```

---

## Problem

1. **Each rail reads value sources by hand.** `check()` reads `value` → `bind` → `path` in
   `field.ts`, reads only `value`/`path` in `date.ts`, and only `value`/`path` for aggregates.
   So a date or aggregate rule with `bind` threw on `check()` while it compiled after
   `resolveBindings`. #18 fixed dates by adding another copy of the binder.
2. **A date `path` that resolves to null compared against the current time.**
   `parseDateValue(undefined)` is `dayjs()`, so `check()` matched rows SQL rejected
   (`col < NULL` is NULL).
3. **`validateRule` rejects every bind-only rule** (`missing_value_source`).
4. **No offset.** "Within 30 days before this other field" and "score ≥ account average + 10"
   can't be written, and a relative window can't take its size from a row.

## Decisions (Aron, 2026-10-06)

- **One reader.** `check()` resolves `value` / `bind` / `path` in one place for field, date and
  aggregate rules, with the bind key-presence contract (`Missing binding`, `bindOptional`,
  `undefined` → `null`).
- **`offset` is a value source** (revised 2026-10-06): `{ value }`, `{ path }` or `{ bind }`
  (with `bindOptional`), read with the comparison value's contract, on any comparison value —
  `value` + `offset` is valid (and is what `resolveBindings` produces).
  - Field rules: it reads a number — a golf handicap (`grossScore <= $.par + $.handicap`), a
    baseline margin, a tolerance bound at evaluation.
  - Date rules: it reads a rolling shift, `{ ago }` / `{ ahead }`, anchored on the comparison
    value; `start of this month + 4 days` needs it. A date offset read per row is check-only.
  - Applies to the comparison operators (`equals` … `greaterThanEquals`, date
    `before` … `notAfter`) and to each endpoint of `between` / `notBetween`.
- **One value-source type** (revised 2026-10-07). `{ value } | { path } | { bind }` is one type,
  `ValueSourceOf<T>`, in every slot that reads a value: the comparison value, an offset, each
  unit amount, the evaluation's `timeZone`. No slot takes a partial copy of it. Offset and
  unit amounts are consumers of the type, not part of it.
- **Units apply in a fixed order**: months (years, quarters, months), then days (weeks, days),
  then time — Postgres interval arithmetic, so `check()` and `toSql` agree at month ends.
- **NULL fails closed.** A null comparison value, offset or magnitude makes the comparison a
  non-match on every rail (SQL NULL arithmetic). A null field keeps the negation ruling.
- **Rails.** `check()` everything. `toSql`: a `$.` ref is column arithmetic
  (`col ± make_interval(…)`, `col + n`); a context ref resolves to a value. `toPrisma`: context
  refs resolve; a `$.` offset or magnitude ref throws, as a `$.` path already does.
- **Lens.** Offset and magnitude refs are gated like `path`: they must resolve through the
  lens, they restrict `describeRule` targets the same way, and `applyLens` refuses to re-root
  them. An offset must fit the field's kind (number → numeric, rolling → DateTime).

## Acceptance (TDD — tests first)

- Paths: date path on every operator family; null path fails closed (check = SQL); `$.`
  column path; magnitude `{ path }` from the row and from context.
- Binds: field, date and aggregate `bind` on `check()`; `validateRule` accepts bind; bind +
  offset on every rail after `resolveBindings`.
- Offsets: numbers and dates from `$.` column, context path, bind and `{ path }` magnitude;
  `between` endpoints; month-end order; NULL; validation errors; lens kind fit.
- PGlite differential: `check()` and executed `toSql` select the same rows.
- `bun run check` green.
