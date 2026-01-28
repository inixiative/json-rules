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
```typescript
// JSONB arrays (default)
{ field: 'tags', arrayOperator: ArrayOperator.empty }
// → ("tags" IS NULL OR jsonb_array_length("tags") = 0)

// Native PostgreSQL arrays (TEXT[], INT[], etc.)
{ field: 'roles', arrayOperator: ArrayOperator.empty, arrayType: 'native' }
// → ("roles" IS NULL OR array_length("roles", 1) IS NULL)
```

### Logical Operators
- `all` (AND), `any` (OR)
- `if/then/else` (conditional logic)
- Nested combinations

## Security

- Field names escaped via `pg.escapeIdentifier()`
- LIKE patterns escaped (%, _, \)
- JSON keys escaped (single quotes)
- All values parameterized ($1, $2, etc.)

---

## Future Considerations: Table Prefixes & Joins

### The Problem

Currently `toSql` generates WHERE clauses for single-table queries. For multi-table queries with JOINs, you need table-qualified field names like `"users"."status"` instead of just `"status"`.

### Simple Solution: Global Table Prefix

Add an options parameter to `toSql`:

```typescript
const { sql, params } = toSql(rule, { tablePrefix: 'u' });
// All fields become "u"."field" instead of "field"
```

This works well for aliased single-table queries or when composing multiple rules:

```typescript
const userWhere = toSql(userRule, { tablePrefix: 'u' });
const postWhere = toSql(postRule, { tablePrefix: 'p' });

const query = `
  SELECT * FROM users u
  JOIN posts p ON p.userId = u.id
  WHERE ${userWhere.sql} AND ${postWhere.sql}
`;
const params = [...userWhere.params, ...postWhere.params];
```

### Why Not Per-Field Tables?

Adding `table` to each rule creates ambiguity with JSON paths:
- `users.status` - is this table.column or column.jsonPath?
- Requires schema awareness to disambiguate
- Leads down the ORM rabbit hole

### Why Not Auto-Joins?

Generating JOIN clauses requires:
- Full schema knowledge (relations, foreign keys)
- Query planning (which tables to join, in what order)
- This is ORM territory (Prisma, Drizzle, etc.)

The rules engine should stay focused on WHERE clause generation. Application code handles JOINs because it knows the schema and query intent.

### Implementation Notes (when needed)

1. Add `ToSqlOptions` type with optional `tablePrefix?: string`
2. Update `quoteField(field, tablePrefix?)` to prepend `"prefix".` when provided
3. Thread options through `buildCondition` and rule builders
4. Param merging when composing multiple `toSql` calls needs care (re-index params)
