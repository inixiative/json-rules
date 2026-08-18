# src/toPrisma/field.ts

## acceptsEmptyString

> `const acceptsEmptyString = (rule: Rule, options?: BuildOptions): boolean => {`

Whether the emptiness operators may compare this column against `''`. Only a
String column accepts it ('' is also a representable JSON value) — Prisma
rejects `equals: ''` on DateTime/Int/enum/… columns outright ("Expected
ISO-8601 DateTime"), turning an authored `isEmpty` into a runtime 500. The
field map is the authority; a stamped `coerceType` is the fallback; with
neither, keep the legacy two-branch shape — an untyped String field must not
lose its ''-branch.

## buildFieldRule

> `if (rule.operator === Operator.isEmpty) {`

isEmpty/notEmpty need OR/AND at the WHERE level (not field-filter level)
because Prisma 6.x rejects mixed null/string in `in`/`notIn` for nullable fields.

## resolveRuleValue

> `const resolveRuleValue = (rule: Rule, options?: BuildOptions): unknown => {`

Resolve the comparison value for a rule.
- rule.value → use literal value
- rule.path starting with '$.' → throw: Prisma WHERE has no column-to-column comparison
- rule.path (context ref) → look up from options.context via lodash get

## buildLeafFilter

> `const val = () => resolveRuleValue(rule, options);`

Lazy resolver: only called by operators that need a value

> `const provider = (options?.datasource?.provider ??`

QueryMode only where the connector accepts it; MySQL/SQLite reject `mode` (collation-driven).

> `throw new Error('isEmpty/notEmpty handled at buildFieldRule level');`

Handled in buildFieldRule — should not reach here

## buildMapAwareFilter

> `const buildMapAwareFilter = (`

Build the Prisma WHERE using map-aware traversal when a map+model is available.
- JSON field mid-path → Prisma JSON path syntax: { metadata: { path: ['theme'], equals: 'dark' } }
- All other paths → standard nested relation filter

> `const jsonFilter = { path: walkResult.jsonPath, ...(filter as object) };`

Merge the json path array into the leaf filter, then nest normally
