# FEAT-007: An aggregate rule's `avg` over no values is NULL, not 0

**Status**: ✅ Approved (Aron, 2026-11-05; `negate()` 2026-11-06)
**Priority**: Medium
**Created**: 2026-11-05
**Target**: 3.21.0 (Aron 2026-11-06: not a major change) — built

## Problem

Since 3.0 (#19, ac37da3), an aggregate rule reads the average of no values as 0 on every rail:
`sumOrAverage` in `check.ts`, `COALESCE(AVG(...), 0)` in `toSql/aggregate.ts`, and the
`holdsEmpty` check against 0 in `toPrisma/aggregate.ts`. The 3.0 intent was rail agreement: a
Prisma `groupBy` has no group for a parent with no matching children, so its sum and average had
to be given a value the other rails could share. 0 is right for `sum`, because the sum of nothing
is 0. It is wrong for `avg`, because the average of nothing does not exist.

Value expressions (3.19.0) return `avg` over no values as null, as SQL's `AVG` does and as `min` /
`max` already do. Aron (2026-11-05) agreed to keep `avg` null in value expressions and to bring
the rule in line through this spec. So today one question has two answers:

- A live rule `{ field: 'fanMissions', aggregate: { mode: 'avg', field: 'points' }, operator: lessThan, value: 3 }`
  matches an advocate with no missions (0 < 3).
- The same test on a field derived from `{ field: 'fanMissions', aggregate: { mode: 'avg', field: 'points' } }`
  and stored (null) does not.

An advocate with no scored missions also lands in every "low average" segment as the worst
performer, which is the bug a stored 0 would have.

## Decision (proposed)

An aggregate rule's `avg` over no values is NULL, compared as a NULL column is compared, on every
rail. `sum` stays 0. That means:

- Positive operators (`equals`, `greaterThan`, `lessThan`, `between`, …) do not match.
- Negated operators (`notEquals`, `notBetween`) match, under the standing ruling that negation keeps
  NULL rows (2.19.0–2.19.2).

Anyone who wants "no values counts as low" writes it: `any: [ count == 0, avg < 3 ]`.

## Test cases (each on check(), toSql via PGlite, and toPrisma; all three must agree)

Rows: `a` has missions with points [2, 4]; `b` has missions with points [null]; `c` has no
missions; `d` has no `fanMissions` key (absent relation).

| Rule on `avg(points)` | a (3) | b | c | d |
| --- | --- | --- | --- | --- |
| `lessThan 5` | ✓ | ✗ | ✗ | ✗ |
| `greaterThanEquals 0` | ✓ | ✗ | ✗ | ✗ |
| `equals 0` | ✗ | ✗ | ✗ | ✗ |
| `notEquals 0` | ✓ | ✓ | ✓ | ✓ |
| `between [0, 10]` | ✓ | ✗ | ✗ | ✗ |
| `notBetween [0, 10]` | ✗ | ✓ | ✓ | ✓ |
| `sum(points) equals 0` (unchanged) | ✗ | ✓ | ✓ | ✓ |

The same table with a `condition` / `filter` that removes every row of `a` gives `a` the `c`
column.

## Changes by rail

- **check():** `sumOrAverage` returns null for `avg` over no values (as `evaluateAggregateValue`
  already does); `checkAggregate` compares through `checkField` with that null, which already
  applies the NULL semantics.
- **toSql:** drop the `COALESCE(…, 0)` for `avg` only; `AVG` over no rows is already NULL.
- **toPrisma:** `holdsEmpty` is computed against null for `avg` (against 0 for `sum`), so a parent
  with no group is selected only when the comparison holds on NULL, i.e. for negated operators.
- **Dogfood:** once the three agree, `checkAggregate` should compute its number with
  `evaluateAggregateValue` and compare it, so the rule and the value can never disagree again.
- Docs: README "Empty-array semantics" (`avg([]) = 0`), the 3.0 CHANGELOG wording, and the test
  named "avg fails (null)" in `test/aggregate.test.ts`, which describes the old behaviour.

## Migration

This changes what existing rules match: any stored rule comparing `avg` with a positive operator
stops matching rows with no values, and negated ones start matching them. Ships in 3.21.0 with a
CHANGELOG entry naming the rewrite (`any: [count == 0, avg …]`). Zealot production holds no stored
rule with `aggregate.mode: 'avg'` (read-only count over all 9 rule columns, 2026-11-05), so no
Zealot rule changes what it matches.

## Out of scope

`sum` (0 is correct), the value expression's `avg` (already null), and `min` / `max` (value
expressions only, already null).

## `negate()` over `avg` (decided, Aron 2026-11-06)

`negate()` must return the condition that holds exactly where the rule doesn't. Today it flips an
aggregate's operator (`lessThan` → `greaterThanEquals`, `equals` → `notEquals`) with no NULL arm,
because `avg` is never NULL. Under this spec it can be, and then the opposite-operator flip is wrong:
`avg lessThan 5` and `avg greaterThanEquals 5` are both false for a row with no values, so that row
satisfies neither the rule nor its "negation".

Decision: negate an `avg` comparison the way `negateLeaf` already negates a field rule, which is
what the standing ruling (negation keeps NULL rows) requires.

- **Complement pairs stay a plain flip.** `equals` ↔ `notEquals` and `between` ↔ `notBetween`
  already split NULL correctly (the negated operator keeps it).
- **Opposite pairs gain a "no values" arm.** `lessThan` / `greaterThanEquals` and
  `greaterThan` / `lessThanEquals` become `any: [opposite, noValues]`. Here `noValues` is the
  aggregate's own `notExists`: the same rule (rows, window, condition) with `operator: 'notExists'`
  and no operand — exactly the field rule's `notExists` arm, with the average in the column's place.
  (Aron 2026-11-06: "Okay, yes, make this consistent. Seems good." — replacing the array-`none`
  spelling first drafted here, which `check()` refused on a primitive list holding only NULLs.)
- **Aggregates take `exists` / `notExists`.** `avg exists` holds where at least one item it reads has
  a value; `sum` always exists (0 over nothing). Every rail compiles both.
- **Nothing to compare against settles as on a field.** A negated operator with no operand
  (`notBetween [null, 3]`, a missing bind) holds where the average has no number, and its negation
  is `avg exists`; a positive one holds nowhere.
- **`sum` is unchanged.** It is never NULL.

| Rule | its negation | a (avg 3) | c (no values) |
| --- | --- | --- | --- |
| `avg lessThan 5` | `any: [avg greaterThanEquals 5, noValues]` | ✗ | ✓ |
| `avg greaterThan 1` | `any: [avg lessThanEquals 1, noValues]` | ✗ | ✓ |
| `avg notEquals 0` | `avg equals 0` | ✗ | ✗ |
| `avg notBetween [0, 10]` | `avg between [0, 10]` | ✓ | ✗ |

Each negation must hold exactly where its rule fails, on all three rails. toPrisma's `holdsEmpty`
check (`toPrisma/aggregate.ts`) uses the same reasoning and moves with it.
