# @inixiative/json-rules

A TypeScript-first JSON rules library for:

- runtime validation with custom error messages
- Prisma query planning
- PostgreSQL `WHERE` generation

The same rule AST can be evaluated against in-memory data with `check()`, converted into a Prisma query plan with `toPrisma()`, or compiled into SQL with `toSql()`.

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
- date comparisons with timezone-aware runtime evaluation
- relative value references via `path`
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
- `endsWith`

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

Empty-array semantics: `sum([]) = 0`, `avg([]) = null` (comparison fails).

### Date Rule

```ts
{
  field: 'expiryDate',
  dateOperator: DateOperator.after,
  value: '2026-01-01'
}
```

## Path Semantics

`path` lets a rule resolve its comparison value from somewhere other than `value`.

### Root Context Reference

In runtime validation, a plain path is resolved from the root context:

```ts
{
  field: 'confirmPassword',
  operator: Operator.equals,
  path: 'password'
}
```

### Current Array Element Reference

Inside array conditions, `$.` means "read from the current element":

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

Aggregate relation filters (`sum`, `avg`) and count-based filters (`atLeast`, `atMost`, `exactly`) can produce multi-step plans. Use `executePrismaQueryPlan()` to resolve `groupBy` step references before passing the final `where` into Prisma.

```ts
import {
  ArrayOperator,
  Operator,
  executePrismaQueryPlan,
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

const where = await executePrismaQueryPlan(plan, { post: prisma.post });
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

const where = await executePrismaQueryPlan(plan, { order: prisma.order });
await prisma.user.findMany({ where }); // users whose orders sum to more than 1000
```

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

## Backend Support Matrix

Not every backend supports every rule shape.

| Capability | `check()` | `toPrisma()` | `toSql()` |
| --- | --- | --- | --- |
| Field operators | Yes | Most | Yes |
| `matches` / `notMatches` | Yes | No | Yes |
| Logical operators | Yes | Yes | Yes |
| Array `all` / `any` / `none` | Yes | Yes | No |
| Array `atLeast` / `atMost` / `exactly` | Yes | Yes, with `map` + `model` | No |
| Array `empty` / `notEmpty` | Yes | Yes | Yes |
| Aggregate `sum` / `avg` — primitive or object array | Yes | No | Yes |
| Aggregate `sum` / `avg` — relation list | Yes | Yes, with `map` + `model` | No |
| Date comparisons | Yes | Most | Yes |
| `dayIn` / `dayNotIn` | Yes | No | Yes |
| `path: '$.field'` current-element / same-row refs | Yes | No | Yes |

### Prisma Limitations

- `matches` and `notMatches` are not supported by Prisma output
- `dayIn` and `dayNotIn` are not supported by Prisma output
- `path: '$.field'` column-to-column comparisons are not supported by Prisma `WHERE`
- count-based and aggregate relation operators require `{ map, model }`
- aggregate rules with `notBetween` are not supported by Prisma output
- aggregate rules on JSON/native stored arrays are not supported by Prisma — use `toSql()` or `check()` for those

### SQL Limitations

- complex array element operators are not supported in SQL output:
  - `all`
  - `any`
  - `none`
  - `atLeast`
  - `atMost`
  - `exactly`
- `toSql()` generates `WHERE` fragments and `LEFT JOIN`s, not complete queries

## TypeScript Types

The public rule types are generic over comparison payloads:

```ts
type Condition<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | Rule<TRuleValue>
  | AggregateRule
  | ArrayRule<TRuleValue, TDateValue>
  | DateRule<TDateValue>
  | All<TRuleValue, TDateValue>
  | Any<TRuleValue, TDateValue>
  | IfThenElse<TRuleValue, TDateValue>
  | boolean;
```

Useful exports:

- `check`
- `toPrisma`
- `executePrismaQueryPlan`
- `toSql`
- `validateRule`
- `assertValidRule`
- `Operator`
- `ArrayOperator`
- `DateOperator`
- `Condition`
- `StrictCondition`
- `Rule`
- `AggregateRule`
- `AggregateMode`
- `ArrayRule`
- `DateRule`

Lens & multi-source:

- `Lens`, `LensNarrowing`, `MapNarrowing`, `ModelNarrowing`
- `FieldMapSet`, `Bridge`, `BridgeEndpoint`, `BridgeCardinality`
- `stitchFieldMaps`, `validateFieldMap`, `validateFieldMapSet`
- `validateNarrowing`, `projectNarrowing`, `checkRuleAgainstLens`, `applyLens`, `getSources`
- `checkWithLens`, `LensCheckData`

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

`check()` throws if `data` is an array but the rule contains any field-based leaf, or if the rule is a fieldless `ArrayRule` and `data` is not an array. Root-array compilation to Prisma/SQL is not yet implemented — these are `check()`-only.

## Lens & Multi-Source Data

The `Lens` primitive is a schema-aware view layer over one or more `FieldMap`s. It enables rule authoring against multi-source data (e.g. Prisma + an external CRM), with declarative cross-source `Bridge`s and recursive `Narrowing`s for picks/omits/constraints.

### FieldMapSet & Bridges

A `FieldMapSet` groups one or more `FieldMap`s and declares the cross-source edges between them:

```ts
import { stitchFieldMaps } from '@inixiative/json-rules';

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
const lens: Lens = {
  map: set,                 // FieldMap | FieldMapSet
  mapName: 'prisma',        // required when map is a FieldMapSet
  model: 'FanUser',         // anchor model
  sources: {                // optional: pre-fetched FE picker data
    'prisma:FanUser.customFields': [{ uuid, fieldKey, label }, ...],
  },
};
```

`sources` is pure data keyed by `<fieldMap>:<Model>[.field?]`. The caller fetches and attaches; the library never fetches. Used by builder UIs to populate pickers tied to schema paths.

### LensNarrowing & `constrains`

`LensNarrowing` is a recursive tree that narrows a parent `Lens` (or another `LensNarrowing`). Each narrowing can add picks/omits per model + a lens-level constraint:

```ts
const narrowing: LensNarrowing = {
  parent: lens,
  maps: {
    prisma: {
      models: {
        FanUser: { picks: ['email', 'firstName', 'crmId'] },
      },
    },
  },
  constrains: { field: 'deletedAt', operator: Operator.isEmpty },
};
```

Children can only narrow further — chain rules enforce `picks ⊆ ancestor picks`, no re-picking an ancestor-omitted field. Constraints AND into any rule evaluated against the lens.

### Lens Utilities

| Function | Purpose |
| --- | --- |
| `validateNarrowing(narrowing)` | Throws on structural or chain violations (incl. unresolvable constraint paths) |
| `projectNarrowing(lens)` | Returns the effective `FieldMapSet` after applying every narrowing in the chain |
| `checkRuleAgainstLens(rule, lens)` | Validates a user rule's field paths against the projected surface; returns `{ ok, violations }` |
| `applyLens(rule, narrowing)` | Returns `{ all: [...chainConstraints, rule] }`; identity if no constraints |
| `getSources(lens)` | Returns the root lens's `sources` |

### `checkWithLens`

Thin wrapper around `check()` that merges supplemental cross-source rows onto a single anchor row before evaluating:

```ts
import { checkWithLens } from '@inixiative/json-rules';

// Caller fetches once, indexes by the foreign side's `on` field
const fanUser = { id: 'u1', email: 'a@b.com', crmId: 'c1' };
const contact = await fetchContact('c1');
const events  = await db.marketingEvent.findMany({ where: { userId: 'u1' } });

const result = checkWithLens(rule, lens, {
  main: fanUser,
  supplemental: {
    'salesforce:Contact': contact,   // 1-1: single object
    'crm:MarketingEvent': events,    // 1-many: array
  },
});
```

Because supplemental keys are `<fieldMap>:<Model>` and the engine's path walker is dotted-key based, paths like `salesforce:Contact.industry` resolve naturally through `lodash.get` — no engine changes for bridge awareness. Cycles in the foreign data are caller-controlled (rules are finite trees, so walks terminate).

For batch evaluation, loop per row:

```ts
const matching = fanUsers.filter((u) =>
  checkWithLens(rule, lens, {
    main: u,
    supplemental: {
      'salesforce:Contact': contactsByCrmId[u.crmId],
      'crm:MarketingEvent': eventsByUserId[u.id],
    },
  }) === true,
);
```

## Examples

See [`examples/basic-validation.ts`](./examples/basic-validation.ts), [`examples/array-operations.ts`](./examples/array-operations.ts), [`examples/aggregate-rules.ts`](./examples/aggregate-rules.ts), [`examples/date-operations.ts`](./examples/date-operations.ts), and [`examples/advanced-features.ts`](./examples/advanced-features.ts).

## License

MIT
