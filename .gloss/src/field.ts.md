# src/field.ts

## isEmptyValue

> `const isEmptyValue = (value: unknown): boolean =>`

A value is "empty" iff it is null, undefined, or the empty string — matching the
SQL backend `(field IS NULL OR field = '')` and Prisma `equals:null | equals:''`.
(lodash isEmpty would also treat Dates/numbers/populated arrays as empty, which
diverges from the compilers and breaks soft-delete grants like `deletedAt isEmpty`.)

## NUMERIC_COERCE_KINDS

> `const NUMERIC_COERCE_KINDS: readonly FieldKind[] = ['Int', 'BigInt', 'Float', 'Decimal'];`

Mirrors the server-side coerceValueForField contract: null/undefined pass through
(the is-null sentinel is valid on every field), arrays coerce element-wise, unknown
kinds pass through, and an uncoercible value returns unchanged so the comparison
fails with the rule's normal error instead of throwing on one dirty row.

## NAIVE_DATETIME

> `const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;`

A datetime string with a time part but no explicit zone (no trailing Z / ±HH:MM).

## coerceScalar

> `if (value instanceof Date) return value.getTime();`

Everything lands on epoch ms so equals/ordered compare across Date
instances, ISO strings (any zone/format), and ms-timestamp strings.
A naive (zoneless) datetime string anchors in UTC — deterministic across
hosts, matching the date rail's parseDateValue default (Date.parse would
anchor it in the host's local zone).

## checkField

> `const fieldValue = applyCoercion(get(data, condition.field) as unknown, condition.coerceType);`

Use data for field access (current element) but context remains available for path references

> `const noValueOps: Operator[] = [`

Operators that don't need a value

> `const fuzzy = resolveFuzzy(condition.fuzzy);`

Fuzzy applies to containment search: typo-tolerant token match over strings, else the
exact containment check. fuzzyContains lowercases internally, so it's case-insensitive.

## getValue

> `if (!bindings || !(condition.bind in bindings))`

Key presence is the contract: an unsupplied binding is a caller bug (a
forgotten scope must never silently run). A supplied-but-nullish binding is
a value — normalize undefined → null (a legit fail-closed filter).

> `if (condition.path.startsWith('$.')) {`

Special case: if path starts with "$." use data (current element)

> `return get(context, condition.path);`

Otherwise use context (root data)
