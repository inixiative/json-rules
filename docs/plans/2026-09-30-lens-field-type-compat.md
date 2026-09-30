# Plan: `checkRuleAgainstLens` gates operator, literal and array-operator fit

**Date**: 2026-09-30
**Target version**: 2.26.0 (makes an existing check stricter; no new public API)
**Status**: Implemented (uncommitted), `bun run check` green. Ticket: FEAT-005

---

## Problem

`checkRuleAgainstLens` resolves every `field` in a rule to its `FieldMapEntry`. It checks
that the path is reachable through the lens and that enum values fall inside the allowed
set. It does **not** check whether the rule's operator, value, or array operator fits that
entry's type. A caller that validates with `validateRule` + `checkRuleAgainstLens` and
persists the rule gets a clean result for a rule that can never evaluate. The first thing
that notices is Prisma, when the compiled filter executes.

Reproduced on `main` (2.25.1). The lens is `Event { name: String, createdAt: DateTime,
account: Account (to-one) }`:

| rule | `checkRuleAgainstLens` | `check()` | `toPrisma` output → Prisma at run time |
|---|---|---|---|
| `{ field: 'createdAt', operator: 'contains', value: 'abc' }` | `ok: true` | `false` (silently never matches) | `{ createdAt: { contains: 'abc' } }`: ``Unknown argument `contains` `` |
| `{ field: 'name', operator: 'equals', value: 123 }` | `ok: true` | `false` (silently never matches) | `{ name: { equals: 123 } }`: `Expected String, provided Int` |
| `{ field: 'createdAt', operator: 'equals', value: 'not-a-date' }` | `ok: true` | `false` (silently never matches) | `{ createdAt: { equals: 'not-a-date' } }`: `Expected ISO-8601 DateTime` |
| `{ field: 'account', arrayOperator: 'any', condition: … }` | `ok: true` | **throws** `account must be an array` | `{ account: { some: … } }`: `some` is a to-many filter; Prisma rejects it on a to-one relation |

The rails disagree as well. `check()` quietly returns "no match" for the first three, and
the Prisma query throws. Under the rule that `check()`, `toSql` and `toPrisma` must agree,
none of these rules is valid on any rail. The lens gate is where that should be caught.

## Why here

- The lens owns the vocabulary, so it answers questions about it. `checkRuleAgainstLens`
  already resolves each field's terminal `FieldMapEntry` (`kind`, `type`, `isList`,
  `values`). It is the only validation layer that knows the column type. `validateRule` is
  grammar-only and has no map.
- **The per-type operator knowledge already exists.** `FIELD_OPERATOR_CATALOG` /
  `DATE_OPERATOR_CATALOG` in `src/operatorCatalog.ts` give every operator a `kinds` list
  (`STRINGY_KINDS`, `ORDERABLE_KINDS`, `EQUATABLE_KINDS`, `['DateTime']`, …). Today only
  `getOperatorsForKind`, the builder's operator picker, reads `kinds`. No validation path
  enforces it. The fix enforces the catalog's existing data. It does not add a second
  table.
- No new walker. The checks go inside the existing `visit` in `src/lens/checkRule.ts`, at
  the point where the terminal entry is already resolved, beside the existing value-set
  check.

## What to build

All three checks push `{ path, reason }` into the existing `violations` array, so every
caller picks them up with no code change. Everything added stays internal: nothing new is
exported from `index.ts`.

### 0. Kind resolution (shared by checks 1 and 2)

In `visit`, keep the resolved `walked.entry` and `walked.jsonSubPath`, alongside the
`terminal*` locals that are already there. Derive the **effective kind** for a leaf:

1. `cond.coerceType` if it is set. It declares the kind both sides compare as.
2. Otherwise, from the declared entry, but only when the path ends **on** the entry
   (`jsonSubPath.length === 0`):
   - `kind: 'enum'` → `Enum`
   - `kind: 'scalar'` with a `type` that is a `FieldKind` → that kind
3. Otherwise **unknown**, and checks 1 and 2 do not run. That covers:
   - a Json sub-path
   - a Json column itself
   - `object` / `bridge` terminals (for example `exists` on a relation)
   - scalar lists (`isList: true` on a scalar)
   - a scalar `type` that is not a `FieldKind` (non-Prisma sources)
   - a field inside an open scope

   This follows the same rule as `isRequired`: when the map says nothing, the check makes
   no claim.

The `FieldMapEntry → FieldKind | undefined` mapping (`entryKind`) lives in the new
lens-internal `src/lens/fieldFit.ts`. `src/operatorCatalog.ts` is star-exported from the
package entry, so putting it there would have added public API with no consumer.
`fieldFit.ts` is not exported from `src/lens/index.ts`.

### 1. Operator ⇄ kind

- **Field rules:** `FIELD_OPERATOR_CATALOG[cond.operator].kinds.includes(kind)`.
- **Date rules:** `DATE_OPERATOR_CATALOG[cond.dateOperator].kinds.includes(kind)`.
- Aggregate rules: out of scope (see Non-goals).
- Reason string:
  `operator 'contains' does not apply to DateTime field 'createdAt' (applies to: String)`
- Use `Object.hasOwn` for the catalog lookup. An unknown operator is `validateRule`'s job;
  skip it here.

### 2. Value ⇄ kind

This runs only for field rules with a literal `value`. It skips:
- `path` refs (another field or context)
- `bind` tokens
- operators whose `valueShape` is `none`

Generalize the existing `extractEnumLiterals` into one literal extractor. It already skips
`path` and flattens arrays, so `in` / `notIn` / `between` / `notBetween` are checked element
by element. Both the enum value-set check and this check use it. `null` always passes,
because the is-null sentinel is valid on every kind.

`literalFitsKind(value, kind)` sits next to the catalog:

| kind | accepts |
|---|---|
| `String`, `Enum` | `string` (the enum allowed set is still checked separately) |
| `Int`, `BigInt` | finite integer `number` |
| `Float`, `Decimal` | finite `number` |
| `Boolean` | `boolean` |
| `DateTime` | a `DateInputValue` for which `parseDateValue(v, 'UTC').isValid()`, using the same definition `validateDateRule` uses. Day-only strings (`'2026-09-01'`), ISO strings with or without a zone, epoch-ms numbers and `Date` all pass. |
| `Bytes`, `Json` | not reached (only `exists`/`isEmpty`-style operators apply, or the kind is unknown) |

**With a `coerceType` that overrides the declared kind:** pass the literal through
`check()`'s own `applyCoercion` from `src/field.ts` first (now exported within the package),
then test the coerced value. For example, `"5"` on a String column with `coerceType: 'Int'`
passes, because `check()` compares it as `5`.

**With a `coerceType` equal to the declared kind** (what `stampCoercions` writes on every
leaf): don't coerce. The compilers pass literals through as written, so a stamp must not
cover for a literal the column rejects. Otherwise a stamped `name equals 123` would pass,
because `check()` turns `123` into `"123"`, but Prisma would still throw.

Reason string: `value 123 does not fit String field 'name' (expected a string)`.

The existing `isDateInputValue` in `src/validate.ts` duplicates the one in `src/date.ts`.
Import the `date.ts` one and delete the copy while you are there.

### 3. `arrayOperator` ⇄ cardinality

This runs for array rules whose `field` resolves to a declared entry. The terminal must be
a list: `entry.isList === true` or a Json column (`isJsonEntry`, open elements). That covers:
- to-many `object`
- `oneToMany` `bridge` (`stitchFieldMaps` always sets `isList`)
- a scalar list, because `check()` iterates it

It rejects:
- a to-one `object` or `bridge`
- a non-list scalar or enum

Fieldless array rules (a root array) and fields inside an open scope are skipped.

Reason string: `arrayOperator 'any' needs a list, but 'account' is a to-one relation`. There
is a scalar variant for non-list scalars.

After pushing this violation, stop descending into `condition` / `filter` for that node.
Their scope is meaningless, and the violations they would add are just noise.

## Must NOT start failing

Every one of these needs an acceptance test:

- Day-only date literal on a DateTime field operator: `{ createdAt, operator: 'greaterThan', value: '2026-09-01' }`.
- Relative date expressions on date operators: `{ ago: { hours: 1 } }`, `{ this: 'month' }`, `{ last: 'week' }`.
- `coerceType` overriding the declared kind: a String column with `coerceType: 'Int'` and
  `greaterThan: 5` (and `"5"`); a String column with `coerceType: 'DateTime'` and an ISO value.
- `path` refs (bare, `$.`, `$$.`) and `bind` tokens: no literal check.
- `exists` / `notExists` / `isEmpty` / `notEmpty` on every kind.
- `equals: null` / `in: [..., null]` on every kind.
- Json column and Json sub-paths: every operator and value exactly as today.
- Bridge-crossing fields: resolved through the bridge's map, gated against that entry.
- Array operators on a to-many relation, a `oneToMany` bridge, a scalar list and a Json column.
- Enum fields: the value-set check is unchanged, and a non-string literal is now also flagged.
- Everything in the existing `test/lens.*` suites stays green unchanged.

## Tests

- New `test/lens.checkRule.fieldTypes.test.ts`:
  - one rejection per check, including the four rules in the table above
  - acceptance for every item in the "must NOT start failing" list
  - the exact reason strings
- **PGlite differential** (`test/lens.checkRule.fieldTypes.pglite.test.ts`):
  - Every accepted rule, stamped via `stampCoercions`, executes on Postgres through `toSql`
    and agrees with `check()`.
  - The rejected rules that Postgres itself refuses (`contains` on timestamptz, an
    unparseable timestamp, a fraction on an integer column) are shown to throw there.
  - Postgres infers types for untyped parameters, so some rejected literals (`name = 123`,
    `count = '5'`) do run on the SQL rail. Prisma's input validation is the rail that
    refuses those, and the unit tests cover them.
  - Found along the way, and existing before this change: an **unstamped** DateTime field
    operator with a string literal disagrees between `check()` (Date vs string, no match)
    and SQL. That is by design, since `check()` never infers types and `stampCoercions` is
    how a lens consumer supplies them. The test stamps accordingly.
- `bun run check` (typecheck + biome + full test suite) green before reporting done.

## Decisions to confirm before coding

1. **`isList` absent on an `object` entry.** Recommendation: treat it as to-one (reject
   array operators). Maps from prisma-map and `stitchFieldMaps` always set `isList`, and
   `check()` throws on a non-array anyway. Any test fixture that omits it will surface in
   the suite run. Fix the fixture; don't loosen the check.
2. **Date operators on a String column.** The catalog says date operators apply to
   `DateTime` only. `check()` can parse date strings stored in a String column, but
   `toPrisma` compares a String column against a Date and throws. The recommendation is to
   enforce the catalog (the rails disagree, so it is a real bug). This is the case most
   likely to hit existing stored rules, so it should be called out in the changelog.
3. **Version.** A minor (2.26.0) with a "stricter validation" note, rather than a patch.
   Rules that passed before can now fail the gate.

## Non-goals (candidate follow-ups, not in this change)

- `aggregate.field` must be numeric for `sum` / `avg`.
- `toPrisma` ignores `coerceType` (it compiles the raw literal against the declared
  column). That is a separate rail divergence that exists today.
- Scalar lists under `toPrisma` (`contains` should compile to `has`).
- Tightening Json semantics.
- `Bytes` equality: the catalog excludes it today, and nothing here depends on it.

## Changelog entry (draft)

```
## 2.26.0 — `checkRuleAgainstLens` gates operator, value and array-operator fit

- **Operator ⇄ field kind.** A field or date operator whose catalog `kinds` exclude the
  resolved field's kind is a violation: "operator '<op>' does not apply to <Kind> field
  '<field>' (applies to: …)". Date operators on a non-DateTime column now fail here.
- **Value ⇄ field kind.** A literal (each element for in/notIn/between) that does not fit the
  field's kind — or its `coerceType`, after check()'s coercion — is a violation: "value <v>
  does not fit <Kind> field '<field>' (expected …)". `null`, `path`, `bind` are not checked.
- **arrayOperator ⇄ cardinality.** An array operator on a to-one relation or non-list scalar
  is a violation: "arrayOperator '<op>' needs a list, but '<field>' is …".
- Undeclared kinds (Json, open scopes, non-FieldKind types, scalar lists) are not gated.
```
