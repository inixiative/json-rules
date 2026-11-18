# FEAT-008: coerced literals in value expressions

**Status:** spec, for Aron's yes before code (a semantic change: `CLAUDE.md` § Lens rulings, last line).

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
- **Stamp:** `coerceValue(expression, lens)` stamps a string literal in an `if`'s `then` / `else`,
  or a list item, with the kind of a sibling branch the lens types as `DateTime` or a numeric kind,
  when the literal reads as that kind. A new `coerceCategorization(categorization, lens)` does the
  same across a categorization's cases and default. Never from values at evaluation; only from
  the lens, as the DateTime aggregate stamp works.
- **Caller target:** when the caller knows the target kind and no branch is lens-typed (every case
  a literal), the builder stamps `coerceType` from the caller's expected kind. json-rules takes
  no expected-type option.

## Test cases

1. `{ value: '2027-01-01', coerceType: 'DateTime' }` evaluates to a `Date`; its type is DateTime.
2. `{ value: '12', coerceType: 'Int' }` evaluates to 12; `{ value: 'x', coerceType: 'Int' }`
   evaluates to `'x'` and types Int.
3. `{ value: true, coerceType: 'DateTime' }` is refused by `inferValueType`: `coerce_kind_mismatch`.
4. `{ path: 'renewedAt', coerceType: 'DateTime' }` is refused by `validateValue`.
5. `coerceValue({ if: c, then: '2027-01-01', else: { path: 'renewedAt' } }, lens)` stamps the
   `then` literal DateTime; the result types DateTime.
6. `coerceValue({ if: c, then: 'gold', else: { path: 'tier' } }, lens)` stamps nothing (String).
7. `coerceCategorization` over cases `'2027-01-01'`, `{ path: 'renewedAt' }` and a default
   `'2026-06-01'` stamps both literals; `describeCategorization` types DateTime.
8. A literal that doesn't read as the sibling's kind (`'soon'` beside a DateTime path) is left as
   it is, and `describeCategorization` reports the mismatch at its case.

## Not in it

No coercion guessed from a literal's own text (`'2027-01-01'` alone stays a String). No
expected-type option in json-rules.
