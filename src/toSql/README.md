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

### Field Operators
- `equals`, `notEquals` (handles NULL correctly)
- `lessThan`, `lessThanEquals`, `greaterThan`, `greaterThanEquals`
- `in`, `notIn` (uses PostgreSQL's `= ANY()` / `<> ALL()`)
- `contains`, `notContains`, `startsWith`, `endsWith` (LIKE patterns, escaped)
- `matches`, `notMatches` (PostgreSQL regex `~` / `!~`)
- `between`, `notBetween`
- `isEmpty`, `notEmpty`, `exists`, `notExists`

### JSON Path Fields
Dot notation accesses JSONB fields:
```typescript
{ field: 'settings.theme', operator: Operator.equals, value: 'dark' }
// → "settings"->>'theme' = $1
```

### Date Operators
- `before`, `after`, `onOrBefore`, `onOrAfter`
- `between`, `notBetween`
- `dayIn`, `dayNotIn` (day of week filtering)

### Array Operators
Array storage type (JSONB vs native `TEXT[]`, `INT[]`, etc.) is derived automatically
from the FieldMap when `map` and `model` options are provided. JSONB is assumed otherwise.

```typescript
// Derived from map — no arrayType annotation needed
{ field: 'tags', arrayOperator: ArrayOperator.empty }
// JSONB  → ("tags" IS NULL OR jsonb_array_length("tags") = 0)
// native → ("tags" IS NULL OR array_length("tags", 1) IS NULL)
```

### Aggregate Rules

Computes `sum` or `avg` of a stored array and produces a scalar comparison.

```typescript
// JSONB primitive array
{ field: 'scores', aggregate: { mode: 'avg' }, operator: Operator.greaterThanEquals, value: 80 }
// → (SELECT AVG(elem::numeric) FROM jsonb_array_elements_text("scores") AS elem) >= $1

// JSONB object array
{ field: 'orders', aggregate: { mode: 'sum', field: 'total' }, operator: Operator.greaterThan, value: 1000 }
// → (SELECT COALESCE(SUM((elem->>'total')::numeric), 0) FROM jsonb_array_elements("orders") AS elem) > $1

// Native array (inferred from map: isList: true on a scalar field)
{ field: 'scores', aggregate: { mode: 'sum' }, operator: Operator.greaterThan, value: 200 }
// → (SELECT COALESCE(SUM(elem), 0) FROM unnest("scores") AS elem) > $1
```

Relation list fields are not supported in `toSql()` — use `toPrisma()` for those.

### Logical Operators
- `all` (AND), `any` (OR)
- `if/then/else` (conditional logic)
- Nested combinations

## Security

- Field names escaped via inline identifier quoting (no `pg` runtime dep)
- LIKE patterns escaped (%, _, \)
- JSON keys escaped (single quotes)
- All values parameterized ($1, $2, etc.)

