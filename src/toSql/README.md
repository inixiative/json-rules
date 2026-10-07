# toSql - PostgreSQL WHERE Clause Generator

Converts json-rules conditions to parameterized PostgreSQL WHERE clauses.

## Usage

```typescript
import { toSql, Operator } from '@inixiative/json-rules';

const rule = { field: 'status', operator: Operator.equals, value: 'active' };
const { sql, params } = toSql(rule);
// sql: '"status" = $1'
// params: ['active']

// Use in a query
await db.query(`SELECT * FROM users WHERE ${sql}`, params);
```

## Supported Features

`toSql` agrees with `check()`: where it can't express a rule as `check()` reads it, it throws
rather than compile something else.

### Field Operators
- `equals`, `notEquals` — a negation keeps NULL rows
- `lessThan`, `lessThanEquals`, `greaterThan`, `greaterThanEquals`
- `in`, `notIn` (`= ANY($1)` / `<> ALL($1)`, with the NULL arm)
- `contains`, `notContains`, `startsWith`, `endsWith`, `notStartsWith`, `notEndsWith` (LIKE,
  escaped)
- `matches`, `notMatches` — the pattern runs in RE2's dialect, translated for Postgres (`.` stops
  at a newline, `\b` is `\y`, classes are ASCII); what Postgres can't express is refused
- `between`, `notBetween`
- `isEmpty`, `notEmpty`, `exists`, `notExists`
- `caseInsensitive` lowers text, `in` / `notIn` members and list members

### Json
A Json column, or a dotted path into one, compares as JSON — by type, as `check()` does:
```typescript
{ field: 'settings.theme', operator: Operator.equals, value: 'dark' }
// → NULLIF("settings"->'theme', 'null'::jsonb) = $1::jsonb   params: ['"dark"']
```

### Date Operators
- `before`, `after`, `onOrBefore`, `onOrAfter`
- `notBefore`, `notAfter` (NULL-keeping complements)
- `within`, `notWithin` (a period or a rolling window)
- `between`, `notBetween`
- `dayIn`, `dayNotIn` (day of week)

A date in Json or text reads as `check()` reads it: a number is epoch milliseconds, a zoned string
that instant, a zoneless one wall time in the evaluation's zone.

### Array Operators
The storage (a native list or a Json array) comes from the FieldMap when `map` and `model` are
given; Json otherwise.

```typescript
{ field: 'tags', arrayOperator: ArrayOperator.empty }
// native → ("t0"."tags" IS NULL OR cardinality("t0"."tags") = 0)
// Json   → ("tags" IS NULL OR "tags" IN ('null'::jsonb, '[]'::jsonb))
```

### Aggregate Rules

`sum` or `avg` over a stored array, compared as a scalar. The sum and the average of nothing are 0.

```typescript
{ field: 'scores', aggregate: { mode: 'sum' }, operator: Operator.greaterThan, value: 200 }
// native → (SELECT COALESCE(SUM(elem), 0) FROM unnest("t0"."scores") AS elem) > $1

{ field: 'items', aggregate: { mode: 'sum', field: 'total' }, operator: Operator.greaterThan, value: 1000 }
// Json → (SELECT COALESCE(SUM((elem->>'total')::numeric), 0)
//          FROM jsonb_array_elements((CASE WHEN jsonb_typeof("items") = 'array' THEN "items" END)) AS elem) > $1
```

A relation list (a to-many relation) takes no array or aggregate rule in `toSql()` — use
`toPrisma()`. Windows (`filter` / `orderBy` / `take` / `skip`) are refused.

### Logical Operators
- `all` (AND), `any` (OR)
- `if` / `then` / `else`

## Security

- Identifiers quoted inline (no `pg` runtime dependency)
- LIKE patterns escaped (`%`, `_`, `\`)
- Json keys escaped
- Every value a parameter (`$1`, `$2`, …)
