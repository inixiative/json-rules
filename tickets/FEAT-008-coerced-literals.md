# FEAT-008: coerced literals in value expressions

**Status:** built (Aron, 2026-11-18: "lets build").

## Intent

Aron, 2026-11-18: "Some of these things are hard, so if we need to add more coercion to literals in
conditional blocks, then let's do it." The case: a value expression is stored as JSON, so a date
literal (`then: new Date('2027-01-01')`) comes back as an ISO string and types as `String`.
Beside a lens-typed branch (`else: { path: 'renewedAt' }`) the two no longer unify, and a
categorization whose cases are date literals types as `String`, so a DateTime target refuses it.

Everything else in a value is already typed from the lens: `coerceRule` stamps field rules,
`coerceValue` stamps `distinct` / `min` / `max` over a DateTime column. A literal has no lens
field behind it. Its kind can come from two places only: the branch beside it, which the lens
types, or the caller's target (Zealot's map column), which the caller knows.

## Shape

A literal written as a value source takes the field rule's own `coerceType` key:
`{ value: '2027-01-01', coerceType: 'DateTime' }`. No new key in the grammar (the value-expression
ruling): `coerceType` already means "read this value as that kind", on field rules and aggregates.

- **Evaluate:** `evaluateValue` reads the literal through `coerceAggregateValue(coerceType, zone)`,
  the reader aggregates already use (`applyCoercion`: `'10'` → 10, a zoneless date in the zone);
  a DateTime comes back as a `Date`. A value the kind can't read stays as it is, as for aggregates.
- **Type:** `inferValueType` gives the literal its `coerceType` as kind, refused with
  `coerce_kind_mismatch` when `coerces(literalKind, coerceType)` is false (the aggregate table).
- **Validate:** `validateValue` takes `coerceType` on a `{ value }` source only (never with `path`
  or `bind`, whose kind comes from the lens or the binding), one of `FieldKind`.
- **Who stamps:** nothing in json-rules. `check()` honours a rule's `coerceType` and never reads a
  lens; `categorize` runs each `if` through `check` and each value through `evaluateValue`, so a
  stamped literal is honoured there with no categorization-specific code. A field rule is stamped
  by `coerceRule` from its column; a literal has no column, and guessing its kind from a sibling
  branch is inference, not a lens fact. The editor stamps it from the kind the caller expects
  (Zealot's map column). json-rules takes no expected-type option and adds no `coerceCategorization`.

## Test cases

1. `{ value: '2027-01-01', coerceType: 'DateTime' }` evaluates to a `Date`; its type is DateTime.
2. `{ value: '12', coerceType: 'Int' }` evaluates to 12; `{ value: 'x', coerceType: 'Int' }`
   evaluates to `'x'` and types Int.
3. `{ value: true, coerceType: 'DateTime' }` is refused by `inferValueType`: `coerce_kind_mismatch`.
4. `{ path: 'renewedAt', coerceType: 'DateTime' }` is refused by `validateValue`.
5. `categorize` over cases `{ value: '2027-01-01', coerceType: 'DateTime' }` and
   `{ path: 'renewedAt' }` returns a `Date` from either case; `describeCategorization` types
   DateTime.
6. The same categorization with the first literal unstamped (`'2027-01-01'`) is reported by
   `describeCategorization` as `value_type_mismatch` (at `$.default`, the branch that disagrees
   with the ones before it, as `unify` reports): nothing guesses it.
7. `coerceValue` leaves a literal as it is (no sibling stamping).

## Not in it

No coercion guessed from a literal's own text or from a sibling branch. No expected-type option
and no `coerceCategorization` in json-rules.
