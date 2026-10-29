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

With `{ map, model }` (a FieldMap, or a FieldMapSet with `mapName`), columns are qualified by the
root alias (`t0`, or `alias`) and relation paths emit `LEFT JOIN`s, returned in `joins`. With
`{ lens }`, the rule is gated by the lens (a rule it refuses throws) and compiles narrowed by
it against its base lens; passing `lens` with
`map` / `mapName` / `model` throws.

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
  at a newline, classes and word boundaries are ASCII); what Postgres can't express is refused
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

## Inline predicates (`whereSql.ts`)

`toWhereSql(condition, { columns, tables?, map, mapName?, model })` writes a condition as a predicate in
the engine's `sql.dialect` (`SqlDialect.postgres` by default, `mysql` the other) with values
inline and every field read from the caller's `columns` map — no parameters, no identifiers, no
joins. It is a separate, deliberately small compiler, not a dialect of `toSql` (which stays
PostgreSQL): `equals`, `notEquals`, `in` (`IN (…)`), `notIn`, `exists`, `notExists`, inside
`all` / `any`, and `any` / `all` / `none` / `empty` / `notEmpty` on a to-many relation of the
model — one `EXISTS` / `NOT EXISTS` subquery on the table the caller gives in `tables`, keyed by
the map's relation keys (`all` tests `IS NOT TRUE`, so a NULL result fails). Every other operator
or node throws, naming it, as do binds, column `path`s, offsets, `coerceType`, case-insensitivity,
bridges, a field rule through a to-many relation, an array rule behind another relation, counts,
windows, anything Json (a stored JSON null is not a SQL NULL) and a DateTime / list *value* (their
existence compiles). The map is required: a value is checked against its column's
kind with `leafFitViolations`, as `validateNarrowing` checks it, and an undeclared path is refused —
MySQL casts a mistyped literal instead of erroring.
Strings double `'`, and `\` on MySQL; negations carry `IS NULL`. A path missing from `columns`
throws. `toLensWhereSql` (`src/lens/toLensWhereSql.ts`) runs it over each visit of a lens that has
`where`s and reports them where the lens wrote them — `root`, `relations` by path, `mapDefaults`
by map and model, each as its layer wrote it (`VisitEffect.pathWheres` / `modelWheres`, beside the narrowed `whereClauses`); an array rule's subquery carries its relation's clamps, which have no join to sit on (`RelationClamps`): those of the layers above the `where`'s own, as `check()` reads it. With `toMany: 'join'` the root's `where` reads the row the caller's LEFT JOIN brings instead (`ToManyRows`, `JoinedRelation`): `notEmpty` is the first key column `IS NOT NULL`, `any(cond)` that AND `cond` on the joined columns. The caller joins every to-many relation the lens shows, ON its keys AND `relations[path]` AND the model default; `tables` is not read. What can hold with no rows (`HOLDS_ON_NO_ROWS_OPERATORS`, from the catalog's `holdsOnNoRows`: `empty`, `none`, `all`, the counts) is refused, as is a to-many read anywhere but the root's `where`, a relation read inside a joined `any`, two `any`s on one joined relation, and a joined relation whose clamps sit in the `where`'s own layer or a later one (the ON carries every layer's; `check()` reads the layers above). See the root README for the absent-vs-hidden semantics and the
collation caveat. `test/whereSql.mysql.test.ts` and `test/whereSql.postgres.test.ts` run one
matrix against a real `mysqld` (mysql-memory-server) and PGlite.

## Security

- Identifiers quoted inline (no `pg` runtime dependency)
- LIKE patterns escaped (`%`, `_`, `\`)
- Json keys escaped
- Every value a parameter (`$1`, `$2`, …)
