# FEAT-005: Lens gate checks operator, value and array-operator fit against the field type

**Status**: 🟡 In review — PR #16
**Priority**: High
**Created**: 2026-09-30
**Target**: **2.26.0** — stricter validation, no new public API

---

## Problem

`checkRuleAgainstLens` confirms that every field a rule names is reachable through the
lens, and that enum values are in the allowed set. It does not confirm that the rule's
operator, value, or array operator fits the field's type. A caller that validates with
`validateRule` + `checkRuleAgainstLens` and then stores the rule gets a clean result for a
rule that can never evaluate. The failure only shows up when the compiled query runs.

Reproduced on 2.25.1. Each rule passes `checkRuleAgainstLens` with `ok: true`:

| rule | fails at run time |
|---|---|
| `{ field: 'createdAt' /* DateTime */, operator: 'contains', value: 'abc' }` | Prisma: ``Unknown argument `contains` ``; Postgres: `operator does not exist: timestamp with time zone ~~ unknown` |
| `{ field: 'name' /* String */, operator: 'equals', value: 123 }` | Prisma: `Expected String, provided Int` |
| `{ field: 'createdAt' /* DateTime */, operator: 'equals', value: 'not-a-date' }` | Prisma: `Expected ISO-8601 DateTime`; Postgres: `invalid input syntax for type timestamp with time zone` |
| `{ field: 'account' /* to-one */, arrayOperator: 'any', condition: … }` | `toPrisma` emits `some` (a to-many filter) on a to-one relation; `check()` throws `account must be an array` |

For the first three, `check()` quietly returns "no match" while the compiled query throws.
The rails disagree, and no rail can actually evaluate the rule.

## Acceptance

- [x] Operator ⇄ field kind, driven by the existing `kinds` in `FIELD_OPERATOR_CATALOG` / `DATE_OPERATOR_CATALOG`
- [x] Literal ⇄ field kind, each element for `in` / `notIn` / `between`; `coerceType` respected
- [x] `arrayOperator` only on a list (to-many relation or bridge, scalar list, Json)
- [x] Every "must not start failing" case in the plan covered by an acceptance test
- [x] PGlite differential: accepted rules execute and agree with `check()`; rejected rules Postgres refuses are shown to throw
- [x] CHANGELOG entry names the new violation reasons
- [ ] Released on the train

## Follow-ups (not in scope)

- `aggregate.field` must be numeric for `sum` / `avg`.
- `toPrisma` ignores `coerceType`, so a String column coerced to Int still compiles the raw
  literal against the text column.
- `toPrisma` compiles field operators on scalar lists without `has` / `hasSome`.
