# @inixiative/json-rules

A TypeScript-first JSON rules library for:

- runtime validation with custom error messages
- Prisma query planning
- PostgreSQL `WHERE` generation

The same rule AST can be evaluated against in-memory data with `check()`, converted into a Prisma query plan with `toPrisma()`, or compiled into SQL with `toSql()`.

> Part of the [inixiative ecosystem](https://github.com/inixiative). See the **[full vocabulary](https://www.inixiative.com/vocabulary.html)** for every primitive — `Condition`, `FieldMap`, lens, sources, builders, and the layers built on them — with what each solves and how it works.

## Installation

```bash
npm install @inixiative/json-rules
# or
yarn add @inixiative/json-rules
# or
bun add @inixiative/json-rules
```

## Quick Start

```ts
import { check, Operator } from '@inixiative/json-rules';

const rule = {
  field: 'age',
  operator: Operator.greaterThanEquals,
  value: 18,
  error: 'Must be 18 or older',
};

check(rule, { age: 21 }); // true
check(rule, { age: 16 }); // "Must be 18 or older"
```

## What It Supports

- scalar comparisons
- nested logical conditions with `all` / `any`
- `if` / `then` / `else`
- array validation against nested object elements
- array aggregates — `sum` and `avg` across numeric arrays or relation lists
- ordered windowing — first/last `N` with `orderBy` / `take` / `skip` (`check()`; `toPrisma()` compiles the extremal case and a `filter` alone)
- date comparisons with timezone-aware runtime evaluation
- relative & calendar date expressions — "last 30 days", "this month" — via `within` and `ago`/`ahead`/`this`/`last`/`next`
- relative value references via `path`, and `$$.` scope refs up through nested arrays
- custom error messages on every rule
- compilation to Prisma and PostgreSQL for supported subsets

## Operators

### Field Operators

- `equals`
- `notEquals`
- `lessThan`
- `lessThanEquals`
- `greaterThan`
- `greaterThanEquals`
- `contains`
- `notContains`
- `in`
- `notIn`
- `matches`
- `notMatches`
- `between`
- `notBetween`
- `isEmpty`
- `notEmpty`
- `exists`
- `notExists`
- `startsWith`
- `notStartsWith`
- `endsWith`
- `notEndsWith`

### Array Operators

- `all`
- `any`
- `none`
- `atLeast`
- `atMost`
- `exactly`
- `empty`
- `notEmpty`

### Aggregate Operators

Used in `aggregate.mode`:

- `sum`
- `avg`

Supported comparison operators for aggregate rules: `equals`, `notEquals`, `lessThan`, `lessThanEquals`, `greaterThan`, `greaterThanEquals`, `between`, `notBetween`.

### Date Operators

- `before`
- `after`
- `onOrBefore`
- `onOrAfter`
- `notBefore`
- `notAfter`
- `within`
- `notWithin`
- `between`
- `notBetween`
- `dayIn`
- `dayNotIn`

## Rule Shapes

### Field Rule

```ts
{
  field: 'status',
  operator: Operator.equals,
  value: 'active'
}
```

### Logical Rules

```ts
{
  all: [
    { field: 'age', operator: Operator.greaterThanEquals, value: 18 },
    { field: 'hasLicense', operator: Operator.equals, value: true }
  ]
}

{
  any: [
    { field: 'role', operator: Operator.equals, value: 'admin' },
    { field: 'isOwner', operator: Operator.equals, value: true }
  ]
}
```

### Conditional Rule

```ts
{
  if: { field: 'type', operator: Operator.equals, value: 'premium' },
  then: { field: 'discount', operator: Operator.greaterThan, value: 0 },
  else: { field: 'discount', operator: Operator.equals, value: 0 }
}
```

### Array Rule

```ts
{
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'total',
    operator: Operator.lessThanEquals,
    path: '$.maxBudget'
  }
}
```

### Aggregate Rule

Computes `sum` or `avg` of an array and compares the result to a value.

```ts
// Primitive numeric array
{
  field: 'scores',
  aggregate: { mode: 'avg' },
  operator: Operator.greaterThanEquals,
  value: 80
}

// Object array — aggregate.field selects the numeric property per element
{
  field: 'orders',
  aggregate: { mode: 'sum', field: 'total' },
  operator: Operator.greaterThan,
  value: 1000
}

// Filtered aggregate — only aggregate elements matching a condition
{
  field: 'orders',
  aggregate: { mode: 'sum', field: 'total' },
  condition: { field: 'status', operator: Operator.equals, value: 'completed' },
  operator: Operator.greaterThan,
  value: 1000
}

// Dot-path field traversal — aggregate through relations
{
  field: 'department.projects',
  aggregate: { mode: 'sum', field: 'budget' },
  condition: { field: 'status', operator: Operator.equals, value: 'active' },
  operator: Operator.greaterThan,
  value: 50000
}
```

Empty-array semantics: `sum([]) = 0` and `avg([]) = 0`. A NULL or absent array is empty, and
NULL items are skipped, as SQL's `SUM` / `AVG` skip them.

### Date Rule

```ts
{
  field: 'expiryDate',
  dateOperator: DateOperator.after,
  value: '2026-01-01'
}
```

### Relative & Calendar Date Expressions

A date rule's `value` can be a structured, serializable expression instead of an
absolute date. Magnitudes are always **positive** — direction lives in the keyword.
A period (`this` / `last` / `next`) names a dayjs unit: `day`, `week`, `isoWeek`, `month`,
`quarter`, `year`, `hour`, `minute`, `second`. A rolling amount (`ago` / `ahead`) counts
`years`, `quarters`, `months`, `weeks`, `days`, `hours`, `minutes`, `seconds`.

**Point expressions** — pair with `before` / `after` / `onOrBefore` / `onOrAfter` /
`notBefore` / `notAfter`,
or as `between` endpoints:

```ts
// "more than 30 days ago"
{ field: 'completedAt', dateOperator: DateOperator.before, value: { ago: { days: 30 } } }

// "not since 30 days ago" — on/before the point OR never (notAfter is the null-carrying
// complement of after; onOrBefore is positive and skips NULL). Takes a literal date too.
{ field: 'lastLoginAt', dateOperator: DateOperator.notAfter, value: { ago: { days: 30 } } }

// "within the next 2 months"
{ field: 'dueAt', dateOperator: DateOperator.after, value: { ahead: { months: 2 } } }

// a named edge of a calendar period
{ field: 'completedAt', dateOperator: DateOperator.before, value: { end: { last: 'month' } } }
```

**Range expressions** — pair with `within` / `notWithin`:

```ts
// "this month"
{ field: 'completedAt', dateOperator: DateOperator.within, value: { this: 'month' } }

// "last week", "next quarter"
{ field: 'completedAt', dateOperator: DateOperator.within, value: { last: 'week' } }

// rolling window: "within the last 30 days"  →  [now - 30d, now]
{ field: 'completedAt', dateOperator: DateOperator.within, value: { ago: { days: 30 } } }

// its complement: "not in the last 30 days" — a never-set date is not in the window, so
// NULL matches (see NULL Semantics). The dormancy rule, in one leaf.
{ field: 'lastLoginAt', dateOperator: DateOperator.notWithin, value: { ago: { days: 30 } } }
```

A **bare period** with `before` / `after` resolves to the only sensible edge —
`before { last: 'month' }` is *before the start* of last month, `after { next: 'month' }`
is *after the end* of next month. Use `{ start: … }` / `{ end: … }` for the other edge.

#### The `now` contract and config

Relative/calendar expressions need a reference instant. `now` is an **explicit
evaluator input** — there is no implicit `Date.now()` inside the library. Pass it
on the same options bag as everything else; `check`/`toPrisma`/`toSql` **throw** if
a relative expression is used without it.

```ts
check(rule, data, { now, timeZone: 'America/New_York', weekStart: 'sunday' });
toPrisma(rule, { map, model, now });
toSql(rule, { now });
```

| Option | Default | Governs |
| --- | --- | --- |
| `now` | — (required when a relative/period expression is present) | the anchor instant |
| `timeZone` | `'UTC'` | how `now` and period boundaries localize — a zone name, or a `{ bind }` read from the bindings |
| `weekStart` | `'monday'` (ISO / isoWeek) | start of `week` for `this`/`last`/`next` |

Compilers resolve expressions to concrete `Date` bounds at compile time, so
`check()`, `toPrisma()`, and `toSql()` all compare the same instant.

### Windowing — first/last with `orderBy` / `take` / `skip`

Array and aggregate rules accept an ordered-window selector that runs **before** the
predicate. Pipeline: filter → order → skip → take. Direction comes from `orderBy.dir`, so
"the last fanMission" is `order by date desc, take 1`. NULLs sort last in both directions, so
`orderBy views desc, take 1` is the largest non-null value.

```ts
// "user whose last fanMission was more than 30 days ago"
{
  field: 'fanMissions',
  orderBy: [{ field: 'completedAt', dir: 'desc' }],
  take: 1,
  arrayOperator: ArrayOperator.all,
  condition: { field: 'completedAt', dateOperator: DateOperator.before, value: { ago: { days: 30 } } },
}
```

`filter` is a condition each element must pass to enter the window (`narrowRule` puts a lens
grant there under `all`). `orderBy` is a non-empty array of `{ field, dir: 'asc' | 'desc' }` (multi-key);
`take`/`skip` are non-negative integers. **Empty-window semantics are author-driven**:
`all` is vacuously true on an empty window, `atLeast: 1` (or `any`) is false. To require
"the windowed element matches **and** one exists," combine `all` with `notEmpty` / `atLeast: 1`.

> **Compilation.** `toPrisma()` compiles the **extremal** case — `take: 1`, a single
> `orderBy`, and a monotonic condition on that same field, with the direction aligned so
> the extremal element is binding (`all` + desc + `before`, `any` + desc + `after`, etc.).
> It rewrites to relation filters: the rule above, with `completedAt` required, is "no missions,
> or some and none since the bound" — `{ OR: [{ fanMissions: { none: {} } }, { AND: [{ fanMissions:
> { some: {} } }, { fanMissions: { none: { completedAt: { gte: <now-30d> } } } }] }] }`. A `filter`
> alone (no `orderBy` / `take` / `skip`) folds into the rule: `all` through the exact complement
> of its condition, the rest as `filter AND condition`. Any other windowed rule — `take > 1`,
> `skip`, multi-key `orderBy`, a different/non-monotonic condition, a misaligned direction, or a
> `filter` beside an ordered window — throws a clear "unsupported" error. `toSql()` does not
> compile windowing at all (no relation subqueries in a `WHERE` fragment). Evaluate the
> unsupported cases in memory with `check()`.

## Path Semantics

`path` lets a rule compare a field with another value on the row; caller-supplied values come
through `{ bind }` (`check(rule, row, { bindings })`; `bindRule` before compiling).

### Root Row Reference

A bare path reads the root row — the record `check()` evaluates, the table a compiler compiles
against:

```ts
{
  field: 'confirmPassword',
  operator: Operator.equals,
  path: 'password'
}
```

### Scope References

Inside an array operator's `condition` or `filter`, `$.` reads from the current element.
Each additional `$` reaches one enclosing element further out: `$$.` is the element of the
enclosing array operator, `$$$.` the one above that, up to the root row. Logical
combinators (`all` / `any` / `if`) never add a level — only array and aggregate rules do.

Both `field` and `path` take the prefix. A bare `field` is always the current element; a
bare `path` is always the root row.

```ts
{
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'lineItems',
    arrayOperator: ArrayOperator.all,
    condition: {
      all: [
        // line item qty against its order's cap
        { field: 'qty', operator: Operator.lessThanEquals, path: '$$.maxQty' },
        // order cap against the root row's limit — neither side is the line item
        { field: '$$.maxQty', operator: Operator.lessThanEquals, path: '$$$.orgLimit' },
      ],
    },
  },
}
```

A ref deeper than the nesting (`$$.` at the top level, `$$$.` one array deep) throws in
`check()`, is a `scope_out_of_bounds` issue from `validateRule`, and an error from
`validateRuleInLens`. A reachable ancestor that lacks the named key fails the comparison
like any absent field.

`toSql()` compiles a bare path or `path: '$.x'` as a same-row column comparison (equality,
ordered and set-free operators; a substring, pattern or set operator against a column throws).
`toPrisma()` compiles one only as a Prisma field reference: both columns of the same model at the
same visit (a bare path at the root, `$.` inside a relation filter), of exactly the same type, with
`equals` / `notEquals` / `lessThan` / `lessThanEquals` / `greaterThan` / `greaterThanEquals` and
no offset. The plan carries a `{ __field }` sentinel that `executePrismaPlan` resolves to
`prisma.<model>.fields.<column>`; read a plan's where only through it. Anything else throws, and
`validateRule(rule, { target: 'toPrisma', map, model })` / `describeRule` report it first. Every
other scope ref — a `$$.` path or any prefixed `field` — is check-only; both compilers throw.

### Offsets and Unit Amounts

An `offset` moves the comparison value. It is a value source of its own, with the comparison
value's contract: `{ value }`, `{ path }` (`$.` from the element, bare from the root row) or `{ bind }`
(with `bindOptional`). A field rule's offset reads a number, added to the comparison value; a
date rule's reads a rolling shift (`{ ago }` / `{ ahead }`) anchored on the comparison value
instead of `now`:

```ts
// net score at or under par: gross <= par + handicap
{ field: 'grossScore', operator: Operator.lessThanEquals, path: '$.par',
  offset: { path: '$.handicap' } }

// within budget plus a tolerance supplied at evaluation
{ field: 'spend', operator: Operator.lessThanEquals, path: '$.budget',
  offset: { bind: 'tolerance' } }

// completed within 30 days before the created date
{ field: 'completedAt', dateOperator: DateOperator.onOrAfter, path: '$.createdDate',
  offset: { value: { ago: { days: 30 } } } }

// on or after the fifth of this month — an edge the expression grammar can't name alone
{ field: 'paidAt', dateOperator: DateOperator.onOrAfter, value: { start: { this: 'month' } },
  offset: { value: { ahead: { days: 4 } } } }
```

`bindRule` resolves an offset's bind as it does the comparison value's, and
`listBindings` lists it. A date offset read per row (a column holding
`{ ago: … }`) is check-only; to size a shift from the row, read the amount instead.

Any relative-date unit — in a `value` expression or an offset's rolling shift — is a number or a
value source: `{ path }` from the row, `{ bind }`, or `{ value }`. A relative
window can take its size from the row it judges:

```ts
// quiet for longer than this incident's rule allows
{ field: 'lastBreachedAt', dateOperator: DateOperator.before,
  value: { ago: { seconds: { path: '$.platformAlertRule.autoResolveAfterSeconds' } } } }
```

Offsets apply to the comparison operators (`equals` … `greaterThanEquals`, `before` …
`notAfter`) and to both ends of `between` / `notBetween`. Units apply as Postgres applies an
interval to a wall-clock time in the evaluation's `timeZone` (UTC by default): months (years,
quarters, months), then days (weeks, days), then time — so every rail lands on the same instant
at a month end and across a DST change. Calendar units (years … days) are whole numbers and every
unit is non-negative: a literal that isn't fails validation, and a value read from data that
isn't reads as null. A null comparison value, offset or magnitude, or a range missing an end,
matches nothing (SQL's NULL arithmetic); a negation keeps null fields only. Numeric offsets add
in double precision on every rail.

| | `check()` | `toSql()` | `toPrisma()` |
| --- | --- | --- | --- |
| literal or bound offset / amount | yes | resolved to a parameter | resolved to a value |
| row (`$.` or bare) numeric offset or unit amount | yes | `col + n` / `col ± make_interval(…)` | throws |
| row (`$.` or bare) date offset (a stored `{ ago }`) | yes | throws | throws |
| `$$.` anything | yes | throws | throws |

`validateRuleInLens` gates offset and magnitude refs like `path` (they must resolve through
the lens and read a number), and an offset must fit the field's kind: a number on a numeric
field, a rolling shift on a DateTime.

## Rule Introspection

Reading a stored rule's own content — which values it names, which bindings it needs — is
engine work, not caller work: a walk written outside the engine goes blind the day the rule
format grows a node type, and it goes blind silently.

| Function | Purpose |
| --- | --- |
| `listBindings(rule, { required: true })` | Names a bindings map must cover — every `{ bind }` token not marked `bindOptional`, sorted. A name optional at one leaf and required at another is required. |
| `listBindings(rule)` | Every `{ bind }` name in the tree, optional or not, sorted — what a lens declares. |
| `bindRule(rule, bindings)` | Substitutes covered binds with their values, leaving uncovered tokens in place (partial resolution). |

A leaf may mark its bind optional: `{ field, operator, bind: 'region', bindOptional: true }`. An
unsupplied required bind is a caller bug — `check()` throws, and both compilers refuse a
surviving token. An unsupplied *optional* bind is `null` wherever absence is final: `check()`
compares against `null`, `toPrisma` / `toSql` compile the token as `null`. The rule is evaluated
as written — the leaf is never pruned, so `in {{bind}}` with nothing bound matches nothing rather
than everything.


## Runtime Validation

`check()` evaluates a rule against data and returns:

- `true` when the rule passes
- a string when the rule fails

```ts
import { ArrayOperator, check, Operator } from '@inixiative/json-rules';

const rule = {
  all: [
    { field: 'status', operator: Operator.equals, value: 'active' },
    {
      field: 'orders',
      arrayOperator: ArrayOperator.atLeast,
      count: 2,
      condition: { field: 'status', operator: Operator.equals, value: 'completed' },
    },
  ],
};

check(rule, {
  status: 'active',
  orders: [
    { status: 'completed' },
    { status: 'pending' },
    { status: 'completed' },
  ],
}); // true
```

### Value Comparison

Values compare as JSON does. Lists and objects compare by value, deeply. Types never cross:
`"3"` never equals `3`, and an ordered comparison or a range holds only between two numbers, two
strings or two dates. A `Date` field value compares as a DateTime without help. To compare a
string literal against a number or Boolean field, stamp the rule's `coerceType` (`coerceRule`
does it from a lens). The compilers refuse a string literal on a number or Boolean column
without one.

An enum compares exactly against its declared values. String, pattern and ordered operators
don't apply to one, and the compilers refuse them. A case-insensitive equality or membership, or
one naming a value the enum doesn't declare, compiles to a membership test over the declared
values `check()` would match (plus the NULL arm for a negation). The field map must list the
values (prisma-map does).

```ts
// map: { models: { U: { fields: { role: { kind: 'enum', type: 'Role' } } } }, enums: { Role: ['admin', 'member'] } }
toSql({ field: 'role', operator: Operator.equals, value: 'ADMIN', caseInsensitive: true }, { map, model: 'U' });
// { sql: '"t0"."role"::text = ANY($1)', params: [['admin']], joins: [] }
toSql({ field: 'role', operator: Operator.startsWith, value: 'adm' }, { map, model: 'U' });
// throws: 'startsWith' does not apply to the enum 'role'; compare its values with equals / in.
```

### Custom Errors

Every rule can define its own error:

```ts
{
  field: 'email',
  operator: Operator.matches,
  value: /^[^@]+@[^@]+\.[^@]+$/,
  error: 'Please enter a valid email address'
}
```

## Prisma Query Planning

`toPrisma()` converts a rule into a Prisma query plan.

```ts
import { Operator, toPrisma } from '@inixiative/json-rules';

const plan = toPrisma({
  field: 'status',
  operator: Operator.equals,
  value: 'active',
});

// plan.steps => [{ operation: 'where', where: { status: { equals: 'active' } } }]
```

Aggregate relation filters (`sum`, `avg`) and count-based filters (`atLeast`, `atMost`, `exactly`) can produce multi-step plans. Use `executePrismaPlan()` to resolve `groupBy` step references before passing the final `where` into Prisma.

```ts
import {
  ArrayOperator,
  Operator,
  executePrismaPlan,
  toPrisma,
} from '@inixiative/json-rules';

const plan = toPrisma(
  {
    field: 'posts',
    arrayOperator: ArrayOperator.atLeast,
    count: 3,
    condition: {
      field: 'published',
      operator: Operator.equals,
      value: true,
    },
  },
  { map, model: 'User' },
);

const where = await executePrismaPlan(plan, { post: prisma.post });
await prisma.user.findMany({ where });
```

Aggregate rules on relation lists work the same way:

```ts
const plan = toPrisma(
  {
    field: 'orders',
    aggregate: { mode: 'sum', field: 'total' },
    operator: Operator.greaterThan,
    value: 1000,
  },
  { map, model: 'User' },
);

const where = await executePrismaPlan(plan, { order: prisma.order });
await prisma.user.findMany({ where }); // users whose orders sum to more than 1000
```

A user with no orders sums to 0, as in `check()`: a comparison that holds at 0 selects the
parents outside the groups where it fails, so childless parents stay in.

### Compiling under a lens

Pass `lens` instead of `map` / `mapName` / `model` and the rule is gated by the lens
(`validateRuleInLens`: a rule it refuses throws; a bare value `path` is a root-row column, gated
like a field), narrowed by it, and compiled against its base lens. `toSql` takes it the same way.
Passing both throws.

```ts
const plan = toPrisma(rule, { lens: narrowing, now });
// Gated by the lens, narrowed by it (a bare `path` too, as a root-row column), then compiled
// against the base lens's map and model.
const where = await executePrismaPlan(plan, prisma);
```

### Json null checks

A Json column holds a DB NULL or a JSON `null`, and a path inside it can be absent — `check()`
reads all three as null, and Prisma matches them together only with its `AnyNull` instance,
which it knows by identity. `toPrisma()` takes it from your installed `@prisma/client` (an
optional peer dependency), so there is nothing to configure; set `prismaOptions.anyNull` only to
use a different client's. Without `@prisma/client`, a Json null check throws.

Prisma filters follow the column kind the map
declares: on Json, `contains` / `startsWith` / `endsWith` become `string_contains` / … and `in`
becomes one `equals` per value; on a scalar list, `contains` becomes `has` and emptiness
`isEmpty`; `caseInsensitive` adds `mode: 'insensitive'` on text only.

## Engine Globals

`engineGlobals` holds process-wide defaults. Keys are dotted paths into one state object.

| Key | Default | Governs |
| --- | --- | --- |
| `string.caseInsensitive` | `false` | Default for a rule's `caseInsensitive`. A rule's own flag wins. Read by `check()`, `toSql()` and `toPrisma()`. |
| `string.fuzzy` | `false` | Default for a rule's `fuzzy` (`true` or a `FuzzyConfig` `{ maxDistance?, maxRatio? }`): typo-tolerant `contains` / `notContains` on strings. A rule's own flag wins. The compilers have no fuzzy form: they refuse `contains` / `notContains` whenever fuzzy is on, by the rule or by this default. |
| `prismaOptions.datasource.provider` | `'postgresql'` | The Prisma connector. `toPrisma()` emits `mode: 'insensitive'` only for `postgresql`, `cockroachdb` and `mongodb`; the others are case-insensitive by collation and reject it. `toPrisma(rule, { datasource: { provider } })` overrides it per call. |
| `prismaOptions.anyNull` | your `@prisma/client`'s | Prisma's `AnyNull` for Json null checks (see above); set it only to use another client's. |

```ts
import { engineGlobals } from '@inixiative/json-rules';

engineGlobals.set('string.caseInsensitive', true);
engineGlobals.get('string.caseInsensitive'); // true
engineGlobals.set('prismaOptions.datasource.provider', 'mysql');
engineGlobals.reset(); // back to the defaults

// A scoped override: merged over the current state for the duration of a synchronous callback.
const result = engineGlobals.with({ string: { caseInsensitive: true } }, () => check(rule, data));
```

`with()` restores the previous state when the callback returns or throws. The callback must be
synchronous: one that returns a Promise throws. `set()` copies plain data and keeps a class
instance (like `AnyNull`) as given, since Prisma recognizes it by identity.

## PostgreSQL SQL Generation

`toSql()` converts a rule into a parameterized PostgreSQL `WHERE` clause.

```ts
import { Operator, toSql } from '@inixiative/json-rules';

const result = toSql({
  field: 'status',
  operator: Operator.equals,
  value: 'active',
});

// {
//   sql: '"status" = $1',
//   params: ['active'],
//   joins: []
// }
```

With a field map and model, `toSql()` can generate `LEFT JOIN`s for relation traversal:

```ts
const result = toSql(
  { field: 'author.email', operator: Operator.equals, value: 'a@b.com' },
  { map, model: 'Post', alias: 't0' },
);

// result.sql   => '"t1"."email" = $1'
// result.joins => ['LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"']
```

`map` is a `FieldMap`, or a `FieldMapSet` (a lens works) with `mapName` naming the map to read,
as `toPrisma()` takes it. A set without `mapName` throws.

```ts
toSql(rule, { map: lens, mapName: 'prisma', model: 'Post' });
```

## Backend Support Matrix

Not every backend supports every rule shape.

| Capability | `check()` | `toPrisma()` | `toSql()` |
| --- | --- | --- | --- |
| Field operators | Yes | Most | Yes |
| `matches` / `notMatches` | Yes | No | Yes |
| Logical operators | Yes | Yes | Yes |
| Array `all` / `any` / `none` | Yes | Yes | No |
| Array `atLeast` / `atMost` / `exactly` | Yes | Yes, with `map` + `model` | No |
| Array `empty` / `notEmpty` | Yes | Yes | Yes (list and Json columns, not relations) |
| Aggregate `sum` / `avg` — primitive or object array | Yes | No | Yes |
| Aggregate `sum` / `avg` — relation list | Yes | Yes, with `map` + `model` | No |
| Date comparisons | Yes | Most | Yes |
| Date expressions (`ago`/`ahead`/`this`/`last`/`next`/`start`/`end`) + `within` | Yes | Yes | Yes |
| `dayIn` / `dayNotIn` | Yes | No | Yes |
| Windowing (`filter` / `orderBy` / `take` / `skip`) | Yes | Extremal (`take: 1`, aligned, no `filter`), or a `filter` alone | No |
| `path` — a bare root-row column, or `$.` the current element's | Yes (reads the row) | Same model, same visit, exactly the same type, with `equals` / `notEquals` / `lessThan(Equals)` / `greaterThan(Equals)` — a Prisma field reference, resolved by `executePrismaPlan`; anything else throws | Yes (a column; not in a relation filter, not a substring or set operator) |
| `offset` and unit amounts — value or bind | Yes | Yes | Yes |
| `offset` and unit amounts — row refs (`$.` or bare) | Yes | No | Yes (not a date offset's) |
| `$$.` scope refs and `$`-prefixed `field` | Yes | No | No |

### NULL Semantics

A negated operator is the complement of its positive form — the same answer
`check()` gives, where `null !== 'x'` is simply true. SQL's three-valued logic
disagrees (`col <> 'x'` is NULL, never true, for a NULL column), so the
compilers carry NULL rows explicitly:

| Rule | `check()` on `{ col: null }` | `toSql()` | `toPrisma()` (nullable column) |
| --- | --- | --- | --- |
| `notEquals 'x'` / `notContains` / `notMatches` / `notBetween` | matches | `(col <> $1 OR col IS NULL)` | `{ OR: [{ col: { not: 'x' } }, { col: { equals: null } }] }` (`notMatches` has no Prisma form) |
| `notIn ['x']` | matches | `(col <> ALL($1) OR col IS NULL)` | `{ OR: [{ col: { notIn: ['x'] } }, { col: { equals: null } }] }` |
| `in ['x', null]` | matches | `(col = ANY($1) OR col IS NULL)` | `{ OR: [{ col: { in: ['x'] } }, { col: { equals: null } }] }` |
| `notIn ['x', null]` | no match | `(col <> ALL($1) AND col IS NOT NULL)` | `{ AND: [{ col: { notIn: ['x'] } }, { col: { not: null } }] }` |
| `equals` / `notEquals` with a column `path` | `null === null` | `IS [NOT] DISTINCT FROM` | `{ col: { equals: fields.other } }` plus the NULL arms of `IS [NOT] DISTINCT FROM` |
| `exists` / `notExists` | `!= null` / `== null` | `IS NOT NULL` / `IS NULL` | `{ not: null }` / `{ equals: null }`; on a required column, whether its row is there (`{ rel: { is: {} } }` / `NOT`, always / never at the root) |

The **absent set** of a path is wider than a NULL leaf: an optional to-one hop can be NULL too,
and `{ rel: { col: { equals: null } } }` only matches when the relation exists. So every negation
also carries `{ rel: { is: null } }` for each optional to-one hop on the path (licensed by the
relation entry's `isRequired: false`) — `profile.bio notEquals 'x'` compiles to
`{ OR: [{ profile: { bio: { not: 'x' } } }, { profile: { bio: { equals: null } } }, { profile: { is: null } }] }`,
matching check() (a missing hop reads as NULL) and toSql (LEFT JOIN + `IS NULL`). `equals null`
and `in [null, …]` carry the same hop arms: a user with no profile has a NULL `profile.bio`.

`toPrisma()` can only add the null arm when it knows the column is nullable —
an `equals: null` on a NOT NULL column is a Prisma validation error. Nullability
comes from the field map: `FieldMapEntry.isRequired: false` (prisma-map emits it).
Without `{ map, model }`, or on an entry that doesn't declare it, the bare
`not` / `notIn` is emitted and NULL rows fall out, as they always did.

Date rules follow the same split. The positive operators answer non-match on both
rails — a bare boundary is not something a NULL column satisfies, so `check()`
reports the rule's ordinary non-match (honoring `error`) and the compilers keep the
bare `<` / `BETWEEN`. The negative-flavored ones (`notBefore`, `notAfter`, `notWithin`, `notBetween`, `dayNotIn`) follow
the negation ruling instead: a never-set date is not in the range, so a null column
MATCHES, and the compilers carry the `IS NULL` arm. To match never-seen rows under a
positive operator, ask for them:
`{ any: [{ field, operator: 'notExists' }, { field, dateOperator: 'before', … }] }`.

| Rule | `check()` on `{ col: null }` | `toSql()` | `toPrisma()` |
| --- | --- | --- | --- |
| positive `dateOperator` (`before`, `between`, `dayIn`, …) | no match | `col < $1` (NULL never satisfies) | `{ col: { lt: … } }` |
| `notAfter X` / `notBefore X` | matches | `(col <= $1 OR col IS NULL)` / `(col >= $1 OR col IS NULL)` | `{ OR: [{ col: { lte } }, { col: { equals: null } }] }` (nullable column) |
| `notWithin { ago: { days: 30 } }` | matches | `(col NOT BETWEEN $1 AND $2 OR col IS NULL)` | `{ OR: [{ NOT: { col: { gte, lte } } }, { col: { equals: null } }] }` (nullable column) |
| `notBetween` | matches | `(col NOT BETWEEN $1 AND $2 OR col IS NULL)` | `{ OR: [{ NOT: { col: … } }, { col: { equals: null } }] }` (nullable column, same field-map licensing as above) |
| `dayNotIn` | matches | `(EXTRACT(DOW FROM col) <> ALL($1) OR col IS NULL)` | — (no Prisma output) |
| `notExists` OR `before` | matches via the first arm | `(col IS NULL OR col < $1)` | `{ OR: [{ col: { equals: null } }, { col: { lt: … } }] }` |

`0` is an instant (1970-01-01) and compares; `''` is malformed data and raises
`"is not a valid date"`.

### Prisma Limitations

- `matches` and `notMatches` are not supported by Prisma output
- `dayIn` and `dayNotIn` are not supported by Prisma output
- `path: '$.field'` column-to-column comparisons are not supported by Prisma `WHERE`; no scope ref (`$$.` path, prefixed `field`) compiles
- count-based and aggregate relation operators require `{ map, model }`
- aggregate rules on JSON/native stored arrays are not supported by Prisma — use `toSql()` or `check()` for those
- element conditions (`all` / `any` / `none` / counts) over a scalar list or a Json array are not supported by Prisma; test a list's membership with `contains`
- a field path through a to-many relation (`posts.title`) is an error on both compilers — compare its rows with an array rule on `posts`
- Prisma loads a NULL scalar-list column as `[]`, so `check()` over Prisma-loaded rows reads it as an empty list while the compilers read NULL; a list Prisma writes is never NULL, so this only matters for rows written outside Prisma

### SQL Limitations

- complex array element operators are not supported in SQL output:
  - `all`
  - `any`
  - `none`
  - `atLeast`
  - `atMost`
  - `exactly`
- `toSql()` generates `WHERE` fragments and `LEFT JOIN`s, not complete queries

### Where the Rails Differ

`check()`, `toSql()` and `toPrisma()` agree on every rule they all compile, except where the
engines themselves differ:

- Case-insensitive comparison follows each engine's case mapping: JavaScript's `toLowerCase` and
  Postgres's `LOWER` under the database collation can differ on letters like `İ`.
- Ordered string comparisons (`lessThan`, `between` on text) follow each engine's order:
  `check()` compares UTF-16 code units, Postgres the column's collation.
- An array or aggregate rule on a Json value that isn't an array is a data error. `check()`
  throws on it; SQL can't raise per row, so it reads the value as an empty array — for an
  aggregate and for `empty` / `notEmpty` alike.

## TypeScript Types

The public rule types are generic over comparison payloads:

```ts
type Condition<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | Rule<TRuleValue>
  | AggregateRule<TRuleValue, TDateValue>
  | ArrayRule<TRuleValue, TDateValue>
  | DateRule<TDateValue>
  | All<TRuleValue, TDateValue>
  | Any<TRuleValue, TDateValue>
  | IfThenElse<TRuleValue, TDateValue>
  | boolean;
```

The public API has one name per operation. [docs/VERBS.md](./docs/VERBS.md) lists every
exported function by verb.

Rules:

- `check`, `toPrisma`, `executePrismaPlan`, `toSql`
- `validateRule`, `assertValidRule`, `bindRule`, `listBindings`
- `Operator`, `ArrayOperator`, `DateOperator`
- `Condition`, `StrictCondition`, `Rule`, `AggregateRule`, `AggregateMode`, `ArrayRule`, `DateRule`, `Row`, `CheckData`
- `GroupByStep`, `WhereStep`, `PrismaStep`, `PrismaWhere`, `StepRef` (a Prisma plan's steps); `ScopeRef`, `ScopedRef`, `ScopeOutOfBounds` (scope refs)
- `CheckOptions`, `CompileOptions`, `ToPrismaOptions`, `ToSqlOptions`, `ToSqlResult`, `ToPrismaResult`, `ValidateRuleOptions`, `ListBindingsOptions`, `ValidationIssue`, `ValidationResult`
- rule parts: `All`, `Any`, `IfThenElse`, `RuleValue`, `RuleScalar`, `OrderedRuleValue`, `ValueSourceOf`, `ValueSourceFields`, `NumberOffset`, `Magnitude`, `WindowFields`, `OrderBy`, `SortDir`
- dates: `DateRuleValue`, `DateInputValue`, `DateInputOrExpr`, `DateExpr`, `RollingExpr`, `PeriodExpr`, `EdgeExpr`, `PeriodUnit`, `RelativeUnits`, `DateOffset`, `DateConfig`, `TimeZoneConfig`, `WeekStart`
- the strict shapes, which pair each operator with its operand's type: `StrictCondition`, `StrictAll`, `StrictAny`, `StrictIfThenElse`, `StrictRule`, `StrictEqualityRule`, `StrictMembershipRule`, `StrictOrderedComparisonRule`, `StrictRangeRule`, `StrictContainsRule`, `StrictStringBoundaryRule`, `StrictPatternRule`, `StrictPresenceRule`, `StrictDateRule`, `StrictDateComparisonRule`, `StrictDateRangeRule`, `StrictDateDayRule`, `StrictArrayRule`, `StrictArrayPredicateRule`, `StrictArrayCountRule`, `StrictArrayPresenceRule`, `StrictAggregateRule`
- `engineGlobals`, `EngineGlobalsState`, `PrismaProvider`, `FuzzyConfig`

Lens & bridges:

- `Lens`, `LensNarrowing`, `ModelNarrowing`, `ModelDefaultNarrowing`, `NarrowingDefaults`, `EnumNarrowing`, `SourceSpec`, `SourceEntry`
- `FieldMap`, `FieldMapEntry`, `ModelEntry`, `SourceOption`, `FieldMapSet`, `Bridge`, `BridgeEndpoint`, `BridgeCardinality`, `BridgeDictionary`
- `createLens`, `storeLens`, `composeLens`, `StoredLens`, `stitchFieldMaps`, `indexBridges`, `validateFieldMaps`, `assertValidFieldMaps`
- `validateNarrowing`, `assertValidNarrowing`, `validateRuleInLens`, `narrowRule`, `coerceRule`
- `bindLens`, `listLensBindings`, `getLensRoot`
- `projectLens`, `walkLensPath`, `readLensValue`, `LensValue`, `describeRule`, `describeRuleSources`
- `toLensSelect`, `projectRows`, `LensSelect`, `LensRelationSelect`, `LensSelectOptions`, `ProjectRowsOptions`
- `toSourceQueries`, `materializeSources`, `materializeSourceQuery`
- `PathProjection`, `ProjectedVisit`, `ProjectLensOptions`, `LensPathHop`, `LensPathResolution`, `RuleDescription`, `RuleSourceDescription`, `SourceQuery`, `SourcePrismaQuery`, `SourceSqlQuery`, `SourceSelect`, `SourceValues`, `SourceRowShape`, `MaterializeSourceQueryOptions`

A lens has three forms, each with its own job:

- **Composed** — a `Lens`, or a `LensNarrowing` whose `parent` holds the layer above it as an
  object, down to the base lens. Every evaluator takes this form.
- **Stored** — `StoredLens`, one record per layer: its `id`, `parents` (the ids of every layer it
  composes with, the base lens first) and its own part. The base lens is the root-most record,
  stored as itself with no parents. `storeLens(lens, ids)` writes a composed lens out as records;
  `composeLens(id, records)` reads them back — fetch the layer, then the ids it lists — validating
  each layer against the ones above it and failing closed on a missing record, a base out of
  place, or a parent whose own list disagrees.
- **Projected** — what a lens exposes, which never leads back to the lens:
  - `projectLens(lens)` returns `Record<dottedPath, ProjectedVisit>` for per-path checks where
    sibling paths to the same model diverge.
  - `projectLens(lens, { by: 'model' })` returns the leak-safe total surface *as a Lens* — every
    model the relations turned on reach, with the full narrowing applied, unioned per model, `where`
    stripped. Use it as the server→client builder surface; it never exposes the raw lens. It is a
    view, not a gate: as a lens it is bare and turns no relation on, so gate rules against the
    narrowing it came from.

```ts
const records = storeLens(grantLens, ['user', 'org-acme', 'grant-7']); // persist each record
// later: fetch 'grant-7', then the ids in its `parents`
const lens = composeLens('grant-7', { user, 'org-acme': orgAcme, 'grant-7': grant7 });
```

### Operator Catalog

What a rule builder can offer for a field. The catalog's constants are `FieldKind`,
`RuleTarget`, `ValueShape`, `NUMERIC_KINDS` and `ALL_KINDS`; `getValueShape(operator, family)` takes an
`OperatorFamily` (`'field' | 'date' | 'array'`).

```ts
import {
  getAggregateOperators,
  getArrayOperators,
  getOperatorsForKind,
  getValueShape,
} from '@inixiative/json-rules';

getOperatorsForKind('Int', 'toPrisma');
// { field: ['equals', 'notEquals', 'lessThan', …], date: [] } — operators that kind takes on that target

getArrayOperators('toSql'); // ['empty', 'notEmpty']
getAggregateOperators(); // ['equals', 'notEquals', 'lessThan', …, 'between', 'notBetween']

getValueShape('between', 'field'); // 'range'
getValueShape('between', 'date'); // 'dateRange'
```

| Function | Purpose |
| --- | --- |
| `getOperatorsForKind(kind, target?)` | `{ field, date }`: the field and date operators a `FieldKind` takes, narrowed to one target when given. |
| `getArrayOperators(target?)` | The array operators, narrowed to one target when given. |
| `getAggregateOperators()` | The comparisons an aggregate rule takes. Every target compiles all of them. |
| `getValueShape(operator, family)` | The operand an operator takes (`'scalar'`, `'range'`, `'dayList'`, …). `family` is `'field'`, `'date'` or `'array'`, since `between` is both a field and a date operator. Throws on an operator the family doesn't have. |

To ask whether a whole rule runs on a target (windows, scope refs and operators together), use
`validateRule(rule, { target })`.

### Scope Refs

`parseScopeRef` and `readScopeRef` read the `$`-prefixed refs described in
[Scope References](#scope-references), for code that resolves refs of its own.

```ts
import { parseScopeRef, readScopeRef } from '@inixiative/json-rules';

parseScopeRef('$$.maxQty'); // { depth: 2, path: 'maxQty' }
parseScopeRef('maxQty'); // null — a bare ref

// scopes run outermost first; `$.` is the last, `$$.` the one before it
readScopeRef('$$.maxQty', [rootRow, order, lineItem]); // { scope: order, path: 'maxQty' }
readScopeRef('maxQty', [rootRow, order]); // { scope: order, path: 'maxQty' }
readScopeRef('$$$.x', [rootRow, order]);
// { outOfBounds: "Scope ref '$$$.x' needs depth 3 but only 2 scopes are in reach" }
```

`readScopeRef` returns the scope a ref names and the path left to read in it. It never throws:
a ref deeper than the stack comes back as `{ outOfBounds }` with the message.

## Error Handling

The library throws when a rule is structurally invalid, for example:

- array operators used against non-arrays
- missing `count` for count-based array rules
- invalid date values
- unsupported backend translations

It returns string errors only from runtime `check()`.

If rules come from JSON, a database, an API, or an editor, validate them first:

```ts
import { assertValidRule, validateRule } from '@inixiative/json-rules';

const result = validateRule(rule, { target: 'check' });
if (!result.ok) {
  console.error(result.errors);
}

assertValidRule(rule, { target: 'toPrisma' });
```

## Root-Array Rules in `check()`

When `data` is an array, the rule must be a tree of `all` / `any` whose leaves are **fieldless** `ArrayRule`s (no `field`, `arrayOperator` operates on the array itself).

```ts
const users = [
  { industry: 'tech', status: 'active' },
  { industry: 'finance', status: 'active' },
  { industry: 'tech', status: 'inactive' },
];

// "Is there any tech user AND are at least 2 active?"
check(
  {
    all: [
      { arrayOperator: ArrayOperator.any, condition: { field: 'industry', operator: Operator.equals, value: 'tech' } },
      { arrayOperator: ArrayOperator.atLeast, count: 2, condition: { field: 'status', operator: Operator.equals, value: 'active' } },
    ],
  },
  users,
);
```

`check()` throws if `data` is an array but the rule contains any field-based leaf, or if the rule is a fieldless `ArrayRule` and `data` is not an array. Root-array rules are `check()`-only: both compilers throw on a fieldless `ArrayRule`.

## Lens & Multi-Source Data

> **For the full lens guide — including the three anchor layers for `where`
> (root, model-default, relation-descent), the `all` operator filter-first
> trick, per-model enum narrowing, and a validate-then-apply usage pattern —
> see [docs/LENS.md](./docs/LENS.md).**
> This section covers the high-level shape and the multi-source bridges.

### What a lens is *for*

A lens is not a query filter. It's a composable, **enforceable model of authority
over data** — *what a party can see and what it can do* — delegated down a chain of
trust boundaries (platform → org → space → subtenant → client). Each layer can only
**narrow**, never widen (`validateNarrowing` keeps the chain monotonic), and the
boundary is **enforced, not documented**:

- a rule authored against a lens provably can't reference outside it —
  `validateRuleInLens`, at author time;
- the row-scope **`where` is the grant, applied server-side at execution** via
  `narrowRule` — the authored rule never sees it and can't escape it;
- what reaches an untrusted party reveals nothing hidden — `projectLens(…, { by: 'model' })`.

A lens defines a **surface area**, reused for distinct, separately-enforced
constraints that may **diverge**: the *data-flow* surface (what you receive / pass
into an interpolated template / expose to a client) vs the *reasoning* surface
(what you may author predicates against — which can be narrower than what you
actually get back). One predicate DSL (`Condition`) expresses both the **grant**
(`where`) and the **use** (rules), compiling to `check` / `toPrisma` / `toSql`.
That's why the same primitive backs permissions, email targeting/conditions,
feature flags, and state-transition guards — it's the authority/visibility spine
they compose on, not a filter helper.

### How it's built

The `Lens` primitive is a schema-aware view layer over one or more `FieldMap`s. It enables rule authoring against multi-source data (e.g. Prisma + an external CRM), with declarative cross-source `Bridge`s and recursive `Narrowing`s for both schema (picks/omits/enumPicks/enumOmits) and data (`where`).

### FieldMap & FieldMapSet

A `FieldMap` is `{ models, enums? }` — models keyed by name, plus an optional enum registry scoped to that source. A `FieldMapSet` groups one or more `FieldMap`s and declares the cross-source edges between them:

```ts
import { stitchFieldMaps } from '@inixiative/json-rules';

const prismaMap = {
  models: {
    FanUser: { fields: { /* ... */ } },
  },
  enums: { UserRole: ['admin', 'member'] },
};

const set = stitchFieldMaps({
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges: [
    {
      endpoints: [
        { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
        { fieldMap: 'prisma',     model: 'FanUser', on: 'crmId' },
      ],
      cardinality: 'oneToMany',
    },
  ],
});
```

`stitchFieldMaps()` injects bridge entries as `kind: 'bridge'` fields on each endpoint model — addressable in rules via `<fieldMap>:<Model>` notation (e.g. `salesforce:Contact.industry`). Each endpoint's `on` is the symmetric join field used at eval time for hydration. Bridge cardinality controls list-vs-single on each side.

### Lens

```ts
// Lens extends FieldMapSet — maps and bridges live at the top level.
// Use `createLens` (it stitches bridges internally) instead of constructing by hand.
import { createLens } from '@inixiative/json-rules';

const lens = createLens({
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges,
  mapName: 'prisma',         // which map in `maps` holds the anchor model
  model: 'FanUser',          // anchor model
});
```

The lens is **schema only** — no data lives on it. Runtime data (rows, foreign tables, FE picker sources) is passed alongside, separately, when you need it.

### Relations

Relations are fields, off by default. A bare lens reads its anchor model's columns and nothing
else. The first narrowing over the base lens turns a relation on through the relation object —
never through `picks`, which names columns only:

```ts
const narrowing: LensNarrowing = {
  parent: lens,
  root: { relations: { org: { relations: { parent: {} } } } }, // along the path
  mapDefaults: {
    prisma: { models: { Org: { relations: { users: {} } } } },  // wherever Org is visited
  },
};
validateRuleInLens({ field: 'org.parent.name', operator: Operator.equals, value: 'Acme' }, narrowing); // ok
validateRuleInLens({ field: 'posts', arrayOperator: ArrayOperator.any, condition: true }, narrowing);
// { ok: false, errors: [{ path: 'posts', code: 'not_in_lens', message: "'posts' is a relation the lens does not turn on …" }] }
```

- **Off is hidden.** A relation that isn't turned on can't be crossed or named (`exists` /
  `notExists` included): the gate refuses it (`not_in_lens`), `walkLensPath` and `readLensValue`
  report it `hidden`, `projectLens` doesn't list it, and `toLensSelect` / `projectRows` don't fetch
  or keep it. That covers every relation a rule, a value `path` or `$` ref, an offset, an
  `orderBy`, a source `label` / `groupBy`, or a read crosses. A bridge is turned on by its key
  (`'salesforce:Contact'`).
- **The relation object carries that hop's narrowing.** `relations.org = { where, picks, omits,
  relations }` narrows Org at that hop; on a model default it narrows the hop wherever the model is
  visited, and may nest further relations.
- **Only the first narrowing turns relations on; later layers narrow.** A later layer may omit a
  relation (`omits: ['org']`, which `picks` never conflicts with), or restate one its parent shows
  to add that hop's narrowing — a restatement hides nothing else. Naming a relation its parent
  doesn't show fails `validateNarrowing` (`not_visible`), and does nothing at runtime.
- **The model defaults grow a tree.** From the anchor and every spelled path, model-default
  turn-ons are followed breadth-first, each model once, at its nearest reach (ties: the earlier
  parent, then the relation declared first). Anything else is reached by spelling it under
  `root.relations`; a spelled node grows its own tree. Every posture walks the same tree, so they
  agree and stay small. `lensVisit(lens, 'org.users')` resolves one visit on demand, as
  `projectLens` would give it, or `null`.
- **Grants.** The first narrowing's `where`s (and source eligibility `where`s) may read any
  relation on the schema; a later layer's may read only what its parent shows — a delegate can't
  probe a relation it can't see (`validateNarrowing` reports it; every posture throws). A bare
  value `path` reads the root row, so only `root.where` may hold one. `toLensSelect` fetches exactly the columns grants read, and
  `projectRows({ keepGrantColumns: true })` keeps them for a re-check.

### LensNarrowing & `where`

`LensNarrowing` is a recursive tree that narrows a parent `Lens` (or another `LensNarrowing`). Each narrowing can add schema picks/omits per model, per-field enum picks/omits, and `where` clauses for data scope:

```ts
const narrowing: LensNarrowing = {
  parent: lens,
  root: {
    // path-specific narrowing at the lens anchor (FanUser)
    picks: ['email', 'firstName', 'crmId'],
    where: { field: 'tenantId', operator: Operator.equals, bind: 'tenantId' },
  },
  mapDefaults: {
    prisma: {
      // applies wherever FanUser appears, root or nested
      models: {
        FanUser: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
      },
    },
  },
};
```

Composition across chained narrowings is pure intersection: relations are turned on by the first narrowing and only hidden after it. `where` clauses are anchored to the model they describe — `root.where` ANDs at the lens anchor, `mapDefaults[X].models[Y].where` injects at every visit of Y in map X, and `root.relations[R]...where` injects when the rule descends through R. Under the `all` array operator the grant goes into the rule's window `filter`, so out-of-scope rows are dropped before the user's "every row matches" check; `check()` and `toPrisma` run it. See [docs/LENS.md](./docs/LENS.md) for the full anchor semantics.

### Lens Utilities

| Function | Purpose |
| --- | --- |
| `validateNarrowing(narrowing)` | Returns `{ ok, errors: { path, message, code }[] }` for structural or chain problems, one code each: `not_in_lens`, `not_visible` (an item an ancestor hid, or a relation the parent doesn't show), `conflicting_selection` (picks beside an omitted column), `wrong_kind` (a relation named in `picks`, among others), `value_not_allowed`, `invalid_source` (a source label / axis crossing a relation that is off, among others), `invalid_binding`, plus the lens gate's codes for a `where`. `assertValidNarrowing` throws instead. Call at narrowing construction. |
| `assertValidFieldMaps(set)` | Throws when a field name in any map holds `.` or `:` (a path step and a bridge marker). `validateFieldMaps(set)` returns `{ ok, errors }` with code `invalid_field_name`. To check a single map, wrap it: `assertValidFieldMaps({ maps: { prisma: map } })`. |
| `projectLens(lens)` | Returns `Record<dottedPath, ProjectedVisit>` — each path the relations turned on reach keys its own resolved narrowing (path picks/omits/enums chain-intersected ∩ `mapDefaults` for the target model); a relation field appears only where it is on. Sibling paths to the same model stay independent. Use for SDK-contract / OpenAPI emission, search-field enumeration, validation whitelists. See [docs/LENS.md §10](./docs/LENS.md). |
| `describeRuleSources(rule, lens)` | The values a rule names at each source the lens declares, keyed like `projectLens` (`path` + `field`, with the source's `mapName` / `model`). Resolved through the lens like `walkLensPath`, so `mapDefaults` sources answer wherever a relation turned on reaches their model. `dynamic: true` when the set can't be enumerated: a `path` / `bind` leaf, an offset or a read amount that moves the value, a substring / pattern / range / window operator, or an operator the catalog doesn't know — callers fail closed on it. The reverse question for a reference registry ("which rows does this rule name") — join `model` + `values`. |
| `validateRuleInLens(rule, lens)` | Validates a user rule's field paths and enum values against the narrowed lens, path-aware. Returns `{ ok, errors: { path, message, code }[] }` like `validateRule` (codes such as `not_in_lens`, `operator_kind_mismatch`, `invalid_value`, `value_not_allowed`). Every relation a field, a value ref, an offset or an `orderBy` / aggregate field crosses must be turned on. A bare value `path` is a root-row column, gated like a field. The security gate. |
| `describeRule(rule, lens)` | `{ sources, bridgesCrossed, supportedTargets, errors }`: the maps a rule reads, whether it crosses a bridge, which of `check` / `toPrisma` / `toSql` can run it (by the rule's shape, as `validateRule` reads it — a compiler may still refuse a field's kind, such as a date rule on a String column on Prisma), and the lens gate's `ValidationIssue`s. For routing and UX; `validateRuleInLens` stays the gate. |
| `getLensRoot(lensOrNarrowing)` | The base lens a narrowing chain is rooted at; a lens is its own. Throws on a cyclic chain. |
| `lensVisit(lens, relationPath, options?)` | One visit as `projectLens` (by path) gives it — its shown fields with values and options, sources, labels and axes — at a dotted relation path from the anchor (`''` for the anchor), resolved on demand: nothing is enumerated, so it is cheap on any schema. `null` when a relation on the path isn't shown there (off, omitted, or outside the model-default tree). A builder walks a lens with it instead of re-deriving the lens's rules. |
| `walkLensPath(lens, path)` | Resolves one dotted path through the lens hop by hop: `{ outcome: 'resolved', hops, terminal, jsonSubPath }`, or `hidden` (a column it doesn't keep, or a relation it doesn't turn on there) / `missing` / `pastScalar` with the failing `index`. |
| `readLensValue(lens, row, path, options?)` | One value off a row, as the lens shows it: `{ ok: true, value }`, or `{ ok: false, reason }` — `hidden` / `missing` / `pastScalar` (the walk `validateRuleInLens` gates a field with), `relation` (the path ends on rows, not a value) or `list` (it crosses a to-many). Each row on the way, the root included, is checked against its visit's grants: one a grant hides, or a missing one, reads `null`. Only own properties are read, into a Json column too. `options` is what each grant is checked with (`now`, `bindings`). For values a template interpolates. |
| `narrowRule(rule, narrowing)` | Composes the user rule with the lens's `where` clauses, injecting each at its anchor in the rule tree. Under an `all`, the grant goes into the rule's window `filter`, which `check()` evaluates and `toPrisma` folds into the rule (`toSql` compiles no relation arrays). Other rules pass to `check` / `toPrisma` / `toSql`. |
| `coerceRule(rule, lens)` | Stamps each field rule with its field's `coerceType` from the lens (`Int`, `Float`, `Decimal`, `BigInt`, `DateTime`, `Boolean`, `String`). Leaves date rules, aggregate comparisons, rules that already carry a `coerceType`, and anything below a Json column alone. |

```ts
import { coerceRule } from '@inixiative/json-rules';

// User.age is { kind: 'scalar', type: 'Int' } in the lens's map
coerceRule({ field: 'age', operator: Operator.equals, value: '3' }, lens);
// { field: 'age', operator: 'equals', value: '3', coerceType: 'Int' }
```

### Bindings in a Lens

A narrowing's `where` and `sources` conditions can hold `{ bind }` tokens, filled per request.

```ts
import { bindLens, listLensBindings } from '@inixiative/json-rules';

const narrowing: LensNarrowing = {
  parent: lens,
  root: { where: { field: 'tenantId', operator: Operator.equals, bind: 'tenantId' } },
};

listLensBindings(narrowing); // ['tenantId']
const bound = bindLens(narrowing, { tenantId: 't-42' });
// bound.root.where => { field: 'tenantId', operator: 'equals', value: 't-42' }
```

| Function | Purpose |
| --- | --- |
| `listLensBindings(lensOrNarrowing)` | The bind names the whole narrowing chain requires, sorted. `bindOptional` tokens are left out, and a `parent:name` reference counts as `name`. |
| `bindLens(lensOrNarrowing, bindings)` | Returns a new narrowing chain with every covered token replaced by its value; uncovered tokens stay, so binding can happen in stages. `parent:name` draws the value of `name`. A bare lens comes back unchanged. The result has the input's type (`bindLens<T extends Lens \| LensNarrowing>(…): T`). The input is not mutated. |

A layer may not re-declare a bind name an ancestor declares; it reads the inherited one as
`parent:name`. `validateNarrowing` reports a collision or a dangling `parent:` reference as
`invalid_binding`.

### Option Sources

A narrowing node's `sources` declares where a field's selectable values come from: a bare
eligibility `Condition`, or a `SourceSpec` `{ where?, label?, groupBy? }`. Two functions turn
the declarations into option sets, and `projectLens(lens, { sourceValues })` attaches the result
to each field as `options`.

```ts
import {
  materializeSourceQuery,
  materializeSources,
  projectLens,
  toSourceQueries,
} from '@inixiative/json-rules';

const narrowing: LensNarrowing = {
  parent: lens,
  root: {
    where: { field: 'tenantId', operator: Operator.equals, value: 't-42' },
    sources: { region: { field: 'active', operator: Operator.equals, value: true } },
  },
};

// Against a database: one DISTINCT query per sourced field, in Prisma and SQL form.
const [query] = toSourceQueries(narrowing);
// query.path => 'User', query.field => 'region'
// query.composedWhere => the node's `where` AND the source's eligibility, narrowed as a rule is
// query.prisma => { model: 'User', distinct: ['region'], select: { region: true }, where: { AND: [...] } }
// query.sql => { sql: 'SELECT DISTINCT "t0"."region" FROM "User" AS "t0" WHERE (...)', params: ['t-42', true] }
const { distinct, select, where } = query.prisma;
const rows = await prisma.user.findMany({ distinct, select, where });
const values = materializeSourceQuery(query, rows); // { path, mapName, model, field, options: [{ value }] }

// Or from rows already fetched under the lens (relations inline):
const all = materializeSources(narrowing, users, { now });

const projection = projectLens(narrowing, { sourceValues: [values] });
// projection.User.fields.region.options => [{ value: 'eu' }, { value: 'us' }]
```

| Function | Purpose |
| --- | --- |
| `toSourceQueries(lensOrNarrowing)` | `SourceQuery[]`, one per sourced field: `{ path, mapName, model, field, label?, groupBy?, composedWhere, prisma, sql }`. `prisma.steps` is present when the where needs `executePrismaPlan`. `sql.sql` is `null` with an `error` when SQL can't express the where. A grouped source drops `distinct`. |
| `materializeSourceQuery(query, rows, { rowShape? })` | One query's fetched rows as `SourceValues`. `rowShape` is `'prisma'` (default: a dotted `label` and each `groupBy` axis come nested) or `'sql'` (they come flat as `__label` / `__group_i`). Options are deduplicated and sorted. |
| `materializeSources(lensOrNarrowing, rows, options?)` | `SourceValues[]` for every sourced field, from rows fetched under the lens (relations inline). Each row at the source's path must pass, through `check()` with `options`, its source `where` narrowed as a rule is, the grants of the visits above it, the guards of the relations its label and axes cross and the values the lens allows; its own visit's `where` is not re-applied, since the rows were fetched under it. A scalar-list field gives one option per element. A `from: 'mapDefaults'` source throws (see below). |

Options never offer a value the lens disallows: `projectLens` drops fetched values outside a
field's allowed set. Nor do they come through a row the lens hides: each source `where` is
narrowed under the whole lens as `narrowRule` narrows a rule — every relation it crosses carries
that visit's grants, inside an array condition (into its `condition`, or its `filter` under `all`,
a window or no condition) and on each hop and terminal relation of a dotted path. A grant a rule
couldn't carry there (one narrowRule can't re-root, a to-many relation read flat) is refused, as
it is for a rule; so is a source whose query has a window toPrisma can't compile (by its shape,
before anything compiles — `materializeSources` refuses it too, so the two never disagree).

#### Two kinds of source

A source declared down a relation path offers the rows **reachable** from there: every grant above
it is carried down, so a Tag source under `User.tagAttachments.tag` offers the tags a live
attachment of an in-tenant user points at. When a field should offer every row the lens lets its
model show — linked or not, what a rule may *name* — point the path source at the model's own
source:

```ts
root: {
  where: { field: 'orgId', operator: Operator.equals, bind: 'orgId' },
  relations: {
    tagAttachments: {
      where: { field: 'deletedAt', operator: Operator.isEmpty },
      relations: { tag: { sources: { id: { from: 'mapDefaults' } } } },   // the model's own source
    },
  },
},
mapDefaults: {
  app: {
    models: {
      Tag: {
        where: { field: 'deletedAt', operator: Operator.isEmpty },
        sources: {
          id: { where: { field: 'ownerId', operator: Operator.equals, bind: 'orgId' }, label: 'name' },
        },
      },
    },
  },
},
```

`from: 'mapDefaults'` resolves where it sits — `mapDefaults[<this path's map>].models[<this path's
model>].sources[<field>]` — and takes that source's eligibility (tenancy included), label and
axes; its own `where`, and child layers, only narrow it. A pointer drops the grants the path
carries down only in the layer that declares it: every layer before or after it still carries
theirs, so a child's pointer can only narrow what its parent gave, and a tenant layer added after a
pointer always narrows it. How depends on how it scopes: through `mapDefaults` (the model's own
grant or source) the pointer still offers unlinked rows; through a root `where` the grant can only
reach the pointer down the path, so it offers just the linked rows — and across a bridge, where no
grant crosses, nothing. Scope tenancy through `mapDefaults` to keep a pointer's unlinked rows.
A pointer whose model declares no source fails `validateNarrowing` (`invalid_source`) and throws
from `projectLens` (by path) / `toSourceQueries` / `materializeSources`, even where a layer hides
its field; `projectLens(…, { by: 'model' })` and `describeRuleSources` read the lens without
validating it. Across a bridge it is how a picker gets options at all: the
model source compiles against the far map alone, with that map's own tenancy, where a path source
offers nothing (until a later layer scopes by a root `where`, as above). `materializeSources` refuses a pointer — a fetched collection can't hold unlinked
rows; query it with `toSourceQueries` and `materializeSourceQuery`.

### Fetching Under a Lens

`toLensSelect` and `projectRows` fetch the rows a lens shows and cut them to it.

```ts
import { check, executePrismaPlan, narrowRule, projectRows, toLensSelect, toPrisma } from '@inixiative/json-rules';

const where = await executePrismaPlan(toPrisma(true, { lens: narrowing, now }), prisma);
const rows = await prisma.user.findMany({ where, ...toLensSelect(narrowing, { now }) });
const shown = projectRows(narrowing, rows, { now });   // what a viewer may see
// To re-test the grants in memory later — never to return to a viewer:
const forRecheck = projectRows(narrowing, rows, { keepGrantColumns: true, now });
const holds = forRecheck.filter((row) => check(narrowRule(rule, narrowing), row, { now }) === true);
```

| Function | Purpose |
| --- | --- |
| `toLensSelect(lensOrNarrowing, options?)` | `{ select }` for `findMany` at the base model. It selects each visit's visible columns and the relations turned on there (one that is off is not fetched; the model-default tree bounds it), and every column a `where` on the way reads. A to-many relation carries its visit's grants compiled as its `where`, so related rows come pre-narrowed — unless a grant reads that list: a grant reads it whole, as the database does, so it is fetched whole and `projectRows` cuts it. A to-one relation takes no `where` in Prisma, so `projectRows` drops one its grant hides. A relation that shows no column — one turned on with all its columns hidden, or one a grant reads only for presence or a count — is fetched by its key alone — the join key, else `id` — even a hidden one, as a grant's columns are; never another column. The fetch carries it for the re-check and a viewer's projection drops it; a model with no key is not fetched, and presence on it can't be re-checked from fetched rows. A root that shows no column is selected by its `id` likewise. Bridges are skipped. A to-many relation's grant that needs a counting step (a count or an aggregate), or has a window toPrisma can't compile, is refused (a `LensRefusal`, which `validateNarrowing` reports) before anything compiles. `options` is the clock for compiling the grants. The root's own grants are the query's `where`: `toPrisma(rule, { lens })`. |
| `projectRows(lensOrNarrowing, rows, options?)` | Rows cut to what the lens shows, recursively. Hidden columns, and relations that are off or omitted, are removed. A row a visit's `where` hides is dropped from the root or a list, and a to-one row becomes `null`. `keepGrantColumns: true` keeps the columns those `where`s read, even hidden ones, and a hidden to-one row, or a hidden row of a list a grant reads, as those columns alone, so `check(narrowRule(rule, lens), row)` re-tests the grants as the database does, for any rule the lens admits; that output carries hidden values, so never return it to a viewer. The other options (`now`, `bindings`) are what each `where` is checked with. Plain JSON in and out. |

### Evaluating Across Bridges

`path:` refs (used for value comparisons) walk via the same dotted-path mechanism as `field:`. Bridge keys (`'salesforce:Contact'`) are just plain object properties, so `path: 'salesforce:Contact.industry'` works in both `field:` (left side) and `path:` (right side) positions.

**Limitations to know:**

- **1-many bridge arrays are not iterable mid-path.** `field: 'crm:MarketingEvent.campaign'` or `path: 'crm:MarketingEvent.campaign'` returns `undefined` when the bridge value is an array — a path read follows own properties one segment at a time and doesn't fan out across array elements. Use a numeric index (`crm:MarketingEvent.0.campaign` or `crm:MarketingEvent[0].campaign`) or `arrayOperator` on the `field:` side to iterate. A name on `Object.prototype` (`constructor`, `toString`) reads as absent.
- **Bridge keys are plain object properties.** The engine doesn't consult `lens.bridges` at eval time — callers structure `data` correctly using the schema as a guide. Use `indexBridges(lens, rawForeign)` to pre-index foreign rows by `on` field, then embed under bridge keys per anchor row.


`check()` itself is bridge-unaware — it walks paths via plain property access. The lens primitive is **schema metadata** (what fields exist, what bridges link them, what `on` fields join each side). The caller is responsible for structuring `data` accordingly:

```ts
const fanUser = { id: 'u1', email: 'a@b.com', crmId: 'c1' };
const contact = await fetchContact(fanUser.crmId);

// Embed the foreign row under its bridge key
const data = { ...fanUser, 'salesforce:Contact': contact };

// Rule references the bridge key in the path
const rule = { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' };
check(rule, data);
```

For **bidirectional traversal**, use JavaScript object references — `check`'s path walker handles circular structures fine because rules are finite trees and only resolve named paths:

```ts
fanUser['salesforce:Contact'] = contact;
contact['prisma:FanUser']     = fanUser;   // back-ref

// Rule walks fanUser → contact → fanUser → email
const rule = { field: 'salesforce:Contact.prisma:FanUser.email', operator: Operator.equals, value: 'a@b.com' };
check(rule, fanUser);
```

For **batch evaluation**, build the anchor array yourself (engine supports root-array rules via fieldless arrayOperators):

```ts
const enriched = fanUsers.map((u) => ({
  ...u,
  'salesforce:Contact': contactsByCrmId[u.crmId],
  'crm:MarketingEvent': eventsByUserId[u.id],
}));

check(
  {
    arrayOperator: ArrayOperator.any,
    condition: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
  },
  enriched,
);
```

The lens schema (with `Bridge.endpoints[*].on`) is what tells the caller how to fetch and index foreign data. The runtime engine just walks the resulting structure.

## Examples

See [`examples/basic-validation.ts`](./examples/basic-validation.ts), [`examples/array-operations.ts`](./examples/array-operations.ts), [`examples/aggregate-rules.ts`](./examples/aggregate-rules.ts), [`examples/date-operations.ts`](./examples/date-operations.ts), and [`examples/advanced-features.ts`](./examples/advanced-features.ts).

## License

MIT
