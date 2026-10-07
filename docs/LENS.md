# Lens deep-dive guide

> The Lens primitive as of 3.0. For library basics (operators, `check()`,
> `toPrisma()`, `toSql()`, bridges, multi-source data evaluation), see the
> [README](../README.md).

## 1. Why Lens exists

AI-authored rules over multi-tenant data need a safety boundary that's
*declarative*, not application code. If the SDK or the model can see every
field on every model and write a `where: tenantId = "other-tenant"` predicate,
no amount of code review will stop the next prompt from doing it. Lens is that
boundary: a schema-aware view layer that says, declaratively, "this is what's
visible, and these are the rows in scope, *anywhere this model is reached.*"
`validateRuleInLens` is the gatekeeper. `narrowRule` is the composer that
injects the scope where clauses at the *right anchor points* in the rule tree
so the resulting query/check operates only on rows the lens admits.

## 2. Two kinds of narrowing

The most important thing to internalize: a `LensNarrowing` contains two distinct
kinds of narrowing, with different concerns. Mixing them up is the fastest way
to write a lens that "works" but leaks scope.

### Schema narrowing — what's *visible*

`picks` / `omits` / `enumPicks` / `enumOmits` control the **type surface**. The
SDK, the AI, the OpenAPI emission — none of them can *mention* a narrowed-away
field or enum value. `projectLens(lens)` produces the path-keyed projection
that reflects this surface, with each declared path getting its own resolved
narrowing.

### Data narrowing — which *rows* are in scope

`where` is a SQL-like filter clause. The field stays visible in the type
surface, but only rows satisfying the `where` are admitted into evaluation.
Filter-first semantic: the rule runs against the filtered set, not the raw
table.

### Same model, different concerns

```ts
import type { LensNarrowing } from '@inixiative/json-rules';
import { Operator } from '@inixiative/json-rules';

// SCHEMA narrowing — `deletedAt` is gone from the visible surface
const surfaceNarrowing: LensNarrowing = {
  parent: lens,
  root: { omits: ['deletedAt'] },
};

// DATA narrowing — `deletedAt` is still visible, but only rows with
// deletedAt = null are in scope
const scopeNarrowing: LensNarrowing = {
  parent: lens,
  mapDefaults: {
    prisma: {
      models: {
        User: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
      },
    },
  },
};
```

The surface narrowing means a rule like `{ field: 'deletedAt', operator: 'exists' }`
will be rejected by `validateRuleInLens` (the field isn't in the projected
surface). The scope narrowing leaves the field visible but guarantees that every
rule executed against the lens runs over non-deleted rows.

## 3. The three anchor layers for `where`

The point of anchored composition is that a `where` does not
always belong at the *root* of the rule. It belongs anchored to the model it
describes — and `narrowRule` finds that anchor point and injects it there.

| Layer | Where it lives | Semantic |
| --- | --- | --- |
| Root | `root.where` | AND at the lens anchor visit. The path-specific home for "scope this lens's root model." |
| Model-intrinsic | `mapDefaults[X].models[M].where` | "Wherever model M appears in map X." Injected at every visit of M. |
| Path-specific descent | `root.relations[R]...where` | Only when the rule descends through R via the path-specific narrowings tree. |

A worked example. Lens root is `User`, with a `posts` relation to `Post`,
each of which has `comments` to `Comment`.

```ts
// Layer 1 — root-anchored, scopes the lens's anchor visit
const n1: LensNarrowing = {
  parent: lens,
  root: { where: { field: 'id', operator: Operator.equals, value: 'u1' } },
};

// Layer 2 — Comment-intrinsic: anywhere a comment is reached, only the
// non-deleted ones are in scope
const n2: LensNarrowing = {
  parent: lens,
  mapDefaults: {
    prisma: {
      models: {
        Comment: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
      },
    },
  },
};

// Layer 3 — only the comments reached *via User.posts.comments* are scoped
const n3: LensNarrowing = {
  parent: lens,
  root: {
    relations: {
      posts: {
        relations: {
          comments: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
        },
      },
    },
  },
};
```

`n2` is usually what you want for "soft-delete everywhere." `n3` is what you
want when a different path to the same model has different visibility rules.
For "scope the lens itself" use `n1` (`root.where`).

## 4. The `all` operator filter-first trick

This is the case anchored composition exists for. Consider:

- Schema: `User { comments: Comment[] }`, `Comment { body, deletedAt }`.
- Lens scope: `mapDefaults.prisma.models.Comment.where = { deletedAt isEmpty }`.
- User rule: `comments.all(body matches /foo/)`.

**The intent**: "Every comment that the user can see matches `foo`." The
deleted comments are not "what the user can see," so they should be filtered
out before the `all` check.

### Naive AND injection — wrong

Same setup, but the lens-level scope is `mapDefaults.prisma.models.Comment.where = { deletedAt isEmpty }`.

```ts
// `{ all: [scope, original] }` inside the comments arrayRule.condition:
{
  field: 'comments',
  arrayOperator: 'all',
  condition: {
    all: [
      { field: 'deletedAt', operator: 'isEmpty' },     // scope
      { field: 'body', operator: 'matches', value: 'foo' }, // user
    ],
  },
}
```

This reads: "every comment is both non-deleted AND matches foo." A single
deleted comment fails the `all` — even though deleted comments are explicitly
out of scope. The scope semantic is broken.

### Filter-first via the window `filter` — right

`narrowRule` injects the `all` grant into the array rule's window `filter`, not its condition:

```ts
{
  field: 'comments',
  arrayOperator: 'all',
  filter: { field: 'deletedAt', operator: 'isEmpty' },            // scope → window filter
  condition: { field: 'body', operator: 'matches', value: 'foo' }, // untouched user condition
}
```

`check` applies the window (`filter`, then any `orderBy`/`take`/`skip`) to the array **before**
evaluating the `all` condition, so out-of-scope rows are dropped first and never participate — the
intuitive "every *in-scope* comment matches foo." The scope *is* the filter.

### Truth table

For a single row, `comments.all(body matches foo)` with
`Comment.where = deletedAt isEmpty`:

| `deletedAt` | in the filtered set? | `body matches foo` | result |
| --- | --- | --- | --- |
| empty (in scope) | yes | match | participates, passes |
| empty (in scope) | yes | no match | participates, fails → `all` fails |
| non-empty (deleted) | no (dropped by `filter`) | — | does not participate |

Deleted rows simply don't participate. A naive `all(scope ∧ user)` instead rejects
the user's data over rows they weren't even asking about.

### Why not a per-row implication?

A previous approach realized the grant as a per-row implication *inside the condition* —
`all(¬scope ∨ user)`, via an internal `negate()`. It was unsound two ways:

- **Under a window** (`orderBy`/`take`/`skip`): `check` applies the window to the *raw* array
  first, so an out-of-scope row could occupy the `take` slot and then be exempted by `¬scope` — a
  **grant bypass** (the lens narrowing silently leaks).
- **Under partial comparison semantics**: `negate` of an ordered comparator (`score > 0` →
  `score <= 0`) is not a true complement when the field is missing — both return false — so an
  out-of-scope row is wrongly forced through the user condition.

Injecting into the `filter` avoids both: there is no `negate`, so no operator needs an inverse (a
`startsWith` grant just works), and the window can't reorder around the scope. The trade-off is
that a narrowed `all` runs on `check()` only. Neither compiler expresses a window `filter`:
`toPrisma` and `toSql` throw on it, and `describeRule` reports `supportedTargets: ['check']`.
Evaluate it with `check()` over rows fetched under the lens.

The other array operators (`any`, `none`, `atLeast`, `atMost`, `exactly`) and `aggregate.condition`
use plain AND injection — filter-first is already preserved by the operator's own meaning.

## 5. Composition rules

Composition across narrowing layers is **pure intersection**. Each layer can
only further restrict what the layers above admit.

- `picks`: intersected — a field has to survive *every* layer's picks to remain visible
- `omits`: union — anything any layer omits is gone
- `enumPicks`: per-field intersection
- `enumOmits`: per-field union
- `where`: collected and AND'd at the anchor (across all layers contributing a where to the same anchor)
- `defaults` + path-specific intersect cleanly: both apply, both narrow

`validateNarrowing()` enforces strict inheritance at construction time. Each
layer can mention only items still visible from layers above *plus same-layer
defaults*. A chained narrowing that re-picks an ancestor-omitted field is an
error:

```ts
validateNarrowing(child);
// { ok: false, errors: [{ path: 'root.picks', code: 'not_visible', message: "'password' was omitted by ancestor" }] }

assertValidNarrowing(child);
// throws:
// validateNarrowing:
// root.picks: 'password' was omitted by ancestor
```

The codes are `not_in_lens`, `not_visible`, `conflicting_selection`, `wrong_kind`,
`value_not_allowed`, `invalid_source` and `invalid_binding`, plus the lens gate's own
codes for a `where`.

The strict check means you find bad lens code at construction, not at query
time with a silently empty result.

`projectLens()` is the projection primitive. A model-keyed projection can't
represent "User looks different at `sourceUser` vs `targetUser`": two sibling
relation paths targeting the same model collapse into one entry. `projectLens`
returns a plain `Record<dottedPath, ProjectedVisit>`, so each declared path keeps
its own resolved narrowing. See section 10 for the API.

## 6. Defaults vs path-specific

`defaults` applies *wherever* a model or enum appears. Path-specific applies
*only* on the path you declared.

```ts
// Schema: User has manager (User) and posts (Post[]); Post.author is User
const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        password: { kind: 'scalar', type: 'String' },
        manager: { kind: 'object', type: 'User' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User' },
      },
    },
  },
};
```

### `mapDefaults[X].models[M]` — everywhere M appears in map X

```ts
const n: LensNarrowing = {
  parent: lens,
  mapDefaults: {
    prisma: {
      models: { User: { omits: ['password'] } },
    },
  },
};
// password is invisible at the root visit (User),
// at User.manager (User again), AND at User.posts.author (User again).
```

### `root` — only at the lens anchor visit

```ts
const n: LensNarrowing = {
  parent: lens, // anchor model = User
  root: { omits: ['password'] },
};
// Hides password only on the lens's root User visit. User reached via
// .manager or .posts.author still has password visible.
// (Use mapDefaults.prisma.models.User for "everywhere" semantics.)
```

### `root.relations[R]...` — only when descending into R

```ts
const n: LensNarrowing = {
  parent: lens,
  root: {
    relations: {
      posts: {
        relations: {
          author: { omits: ['password'] }, // only on the .posts.author User visit
        },
      },
    },
  },
};
// User.manager still has password visible. User.posts.author does not.
```

## 7. Per-model and per-type enum narrowing

Enum value visibility composes from up to five sources, intersected per field:

1. The registry — `FieldMap.enums[enumType]` (declared once per source)
2. The per-field override — `FieldMapEntry.values` (a field can declare a
   tighter set than its type's registry — useful for narrow-purpose fields)
3. `mapDefaults[X].enums[enumType]` — narrow the enum *type* (applies to every
   field of that type in map X)
4. `mapDefaults[X].models[Y].enumPicks/enumOmits[field]` — per-field on a default
   model (applies wherever Y appears in map X)
5. `enumPicks` / `enumOmits` on `root` or `root.relations[...]` — per-field
   path-specific

```ts
const map: FieldMap = {
  models: {
    User: { fields: { role: { kind: 'enum', type: 'UserRole' } } },
    Audit: { fields: { targetRole: { kind: 'enum', type: 'UserRole' } } },
  },
  enums: {
    UserRole: ['admin', 'member', 'owner', 'guest'], // registry: source of truth
  },
};

// (3) mapDefaults.prisma.enums.UserRole.omits=[guest] — narrows the registry to
// admin/member/owner everywhere in this map.
// (4) mapDefaults.prisma.models.User.enumOmits.role=[owner] — drops owner from
// User.role wherever User appears.
// (5) root.enumPicks.role=['admin'] — at the lens anchor's User visit, picks admin only.
const n: LensNarrowing = {
  parent: lens,
  root: { enumPicks: { role: ['admin'] } },
  mapDefaults: {
    prisma: {
      enums: { UserRole: { omits: ['guest'] } },
      models: { User: { enumOmits: { role: ['owner'] } } },
    },
  },
};
// User.role allowed at root visit = registry ∩ mapDefaults.enums ∩ mapDefaults.models.User.enumOmits ∩ root.enumPicks
//   = ['admin','member','owner','guest'] ∩ ['admin','member','owner'] ∩ ['admin','member'] ∩ ['admin']
//   = ['admin']
// Audit.targetRole is untouched by layers 4 & 5; gets registry ∩ mapDefaults.enums
//   = ['admin','member','owner'].
```

Validation enforces this layering at construction time (`validateNarrowing`):
layer 5 picks can't reference values omitted by layer 4 or 3 or by ancestor's
same-position layer-5 narrowing. Same for layer 4 against layer 3 and ancestor's
same-position layer 4. A test in `v2_1.validateNarrowing.test.ts` exercises each
boundary.

### Surfacing the narrowed enum to a builder/SDK

`projectLens` materializes the per-field allowed set onto `FieldMapEntry.values`
on each visited field at each path, with all three enum narrowing layers
composed. The consumer reads it directly:

```ts
const projection = projectLens(lens);
const allowed = projection.User?.fields.role?.values ?? [];
```

Each path key gets its own resolved field set, so path-specific enum divergence
is preserved (e.g. `User.role` picks `['admin']` at root and `['member']` via
`posts.author` — each path's allowed values stand on their own, no leakage).

`validateRuleInLens` rejects rule values not in the resolved set — leaf
rules, plus inside `all`/`any`/`if`/`arrayRule.condition` (it recurses with
model-context awareness so a value like `users.any(role equals 'GHOST')`
correctly resolves against `User.role`, not the lens root).

## 8. The complete type shape

```ts
import type { Condition } from '@inixiative/json-rules';

/** A schema map: models keyed by name, plus an optional enum registry
 *  scoped to this source. In multi-source setups (Prisma + Salesforce + CRM)
 *  each FieldMap carries its own enums so namespaces don't collide. */
type FieldMap = {
  models: Record<string, ModelEntry>;
  enums?: Record<string, readonly string[]>;
};

/** Per-source set of FieldMaps + cross-source bridges. */
type FieldMapSet = {
  maps: Record<string, FieldMap>;
  bridges?: Bridge[];
};

/** A Lens anchors a FieldMapSet at a specific (mapName, model). */
type Lens = FieldMapSet & {
  mapName: string;
  model: string;
};

/** Narrowing applied wherever a model appears (intrinsic to the model).
 *  No `relations` — relations are path-specific by definition. */
type ModelDefaultNarrowing = {
  picks?: string[];                                       // schema: keep only these fields
  omits?: string[];                                       // schema: drop these fields
  enumPicks?: Record<string, readonly string[]>;          // schema: per-field enum allow-list
  enumOmits?: Record<string, readonly string[]>;          // schema: per-field enum deny-list
  where?: Condition;                                      // data: row-level filter (filter-first)
  sources?: Record<string, SourceValue>;                  // per-field option sources (see README)
};

/** A `sources` entry: a bare eligibility Condition, or a spec with a label and/or groupBy. */
type SourceValue =
  | Condition
  | { where?: Condition; label?: string; groupBy?: string | string[] }; // at least one key

/** Narrowing for a model at a specific traversal path. Adds relations. */
type ModelNarrowing = ModelDefaultNarrowing & {
  relations?: Record<string, ModelNarrowing>;             // descend further
};

/** Narrowing for an enum *type* (anywhere the enum is referenced in this map). */
type EnumNarrowing = {
  picks?: readonly string[];
  omits?: readonly string[];
};

/** Applies-everywhere narrowings for one map — per-model (no relations) + per-enum-type. */
type NarrowingDefaults = {
  models?: Record<string, ModelDefaultNarrowing>;
  enums?: Record<string, EnumNarrowing>;
};

/** A narrowing in a chain. Children only narrow further. */
type LensNarrowing = {
  parent: Lens | LensNarrowing;
  /** Path-specific narrowing anchored at (lens.mapName, lens.model). Descends
   *  via .relations and may cross maps through bridge relations. */
  root?: ModelNarrowing;
  /** Per-map applies-everywhere narrowings, keyed by map name. */
  mapDefaults?: Record<string, NarrowingDefaults>;
};
```

## 9. Building a lens

```ts
import { createLens } from '@inixiative/json-rules';
import type { FieldMap, Bridge } from '@inixiative/json-rules';

const prismaMap: FieldMap = {
  models: {
    User: {
      fields: {
        id:        { kind: 'scalar', type: 'String' },
        tenantId:  { kind: 'scalar', type: 'String' },
        crmId:     { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        role:      { kind: 'enum',   type: 'UserRole' },
        posts:     { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id:        { kind: 'scalar', type: 'String' },
        title:     { kind: 'scalar', type: 'String' },
        published: { kind: 'scalar', type: 'Boolean' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        author:    { kind: 'object', type: 'User' },
      },
    },
  },
  enums: { UserRole: ['admin', 'member', 'owner', 'guest'] },
};

const salesforceMap: FieldMap = {
  models: {
    Contact: {
      fields: {
        id:       { kind: 'scalar', type: 'String' },
        industry: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const bridges: Bridge[] = [
  {
    endpoints: [
      { fieldMap: 'salesforce', model: 'Contact', on: 'id' },    // "one" side
      { fieldMap: 'prisma',     model: 'User',    on: 'crmId' }, // "many" side
    ],
    cardinality: 'oneToMany',
  },
];

const lens = createLens({
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges,
  mapName: 'prisma',
  model: 'User',
});
```

A typical narrowing — server-side scope + soft-delete + a schema trim:

```ts
import type { LensNarrowing } from '@inixiative/json-rules';
import { Operator } from '@inixiative/json-rules';

const narrowing: LensNarrowing = {
  parent: lens,
  mapDefaults: {
    prisma: {
      models: {
        // every User row visited, anywhere, must match tenantId
        User: {
          omits: ['deletedAt'], // schema: hide the field too
          where: { field: 'tenantId', operator: Operator.equals, path: 'tenantId' },
        },
        // every Post: not deleted
        Post: {
          omits: ['deletedAt'],
          where: { field: 'deletedAt', operator: Operator.isEmpty },
        },
      },
    },
  },
};
```

## 10. Using the lens

### `validateRuleInLens(rule, lens)` — validate at the API boundary

This is the *gatekeeper*. Call it on every user-authored rule before doing
anything else with it.

```ts
import { validateRuleInLens } from '@inixiative/json-rules';

const userRule = {
  field: 'posts',
  arrayOperator: 'all',
  condition: { field: 'published', operator: Operator.equals, value: true },
};

const check = validateRuleInLens(userRule, narrowing);
// { ok: boolean, errors: Array<{ path, message, code }> }

if (!check.ok) {
  return res.status(400).json({ errors: check.errors });
}
```

It walks the rule AST per-path, resolves every field against the projected
surface at the right visit, and reports:

- field paths that don't resolve through the narrowed lens
- enum values not in the allowed set
- nested-condition fields validated against the *relation target*, not the
  lens root

#### The Json boundary

A `Json` field declares no sub-fields, so a dotted sub-path into one is
open-ended: `check`/`toPrisma`/`toSql` resolve the remaining segments against
the JSON value at evaluation time. Path resolution therefore **stops at the Json
column** and everything below it is accepted as-is.

```ts
validateRuleInLens({ field: 'metadata.theme.color', operator: 'equals', value: 'red' }, lens);
// ok — resolution stops at the visible `metadata` column
validateRuleInLens({ field: 'firstName.foo', operator: 'equals', value: 'x' }, lens);
// rejected — open-endedness is exclusively a Json-boundary property
```

What follows from that:

- **Narrowing governs the column, not the sub-path.** Omit or pick away
  `metadata` and every `metadata.*` rule is rejected with it; keep the column
  and every sub-path under it is reachable.
- **No relation traversal resumes below the boundary.** A JSON key that happens
  to share a name with a declared relation is still just a JSON key.
- **The column's own value set does not gate its sub-paths.** `values`,
  `options`, `enumPicks`/`enumOmits` describe the column; a rule on
  `metadata.theme` compares an undeclared value and is not checked against them.
  A rule on the bare `metadata` column still is.
- **Nested scopes below the boundary are open.** An `arrayOperator` or
  `aggregate` over a JSON array iterates undeclared elements, so its
  `condition`, `filter`, `orderBy` and `aggregate.field` — and any `$.`
  comparison ref inside them — are accepted without resolution. A root-anchored
  `path` ref is still gated: it resolves at the lens anchor, not in the JSON. So
  is a `$$.` ref that climbs back out to a declared ancestor: it is gated at the
  scope it names, exactly as it would be outside the boundary.
- **No kind-specific narrowing applies.** The value kind below the boundary is
  unknown, so the generic operator set is allowed and `coerceRule` leaves
  the rule unstamped. This mirrors `check`, which compares the traversed JSON
  value untyped — a type mismatch fails the comparison rather than throwing.

`describeRule` follows the same boundary, so a Json sub-path is never reported
as an error.

### `narrowRule(rule, narrowing)` — compose with scope

Once a rule has passed the gate, run it through `narrowRule` to get the
**composed rule** with all where clauses injected at their proper anchors. Pass
the result to `check()`, `toPrisma()`, or `toSql()`.

```ts
import { check, narrowRule } from '@inixiative/json-rules';

const composed = narrowRule(userRule, narrowing);
// composed now contains the user rule + tenantId/deletedAt wheres anchored
// at every User and Post visit. Under the `all`, the Post grant is the
// array rule's window `filter`, so only check() runs it.

check(composed, userWithPosts);
```

A rule with no narrowed `all` compiles as usual:

```ts
import { executePrismaPlan, toPrisma } from '@inixiative/json-rules';

const composed = narrowRule(anyPublishedRule, narrowing);
const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
const where = await executePrismaPlan(plan, { post: prisma.post });
```

### `projectLens(lens)` — path-keyed projection

```ts
import { projectLens } from '@inixiative/json-rules';

const projection = projectLens(narrowing);
// Record<dottedPath, ProjectedVisit> — a plain object
//   key:   dotted path from the lens anchor, e.g. "Post", "Post.author", "Post.editor"
//   value: { mapName, modelName, fields, whereClauses, sources, sourceLabels, sourceGroupBys }
```

Pass `{ sourceValues }` (from `materializeSources` / `materializeSourceQuery`) to attach
each sourced field's fetched `options`.

`ProjectedVisit.fields` contains only the fields visible at *this specific
visit*. Composition at each visit: path-specific picks/omits/enumPicks/enumOmits
(chain-intersected across narrowing layers) ∩ `mapDefaults[X].models[Y]` for
the target model (chain-intersected) ∩ `mapDefaults[X].enums` registry
narrowing. Enum allowed values are inlined into each field entry's `.values`.

Sibling paths to the same model are independent — `Post.author` and
`Post.editor` each carry their own narrowing, no leakage. This is the
foundation for any path-aware consumer: validation whitelists, SDK schema
generation, search-field enumeration.

Example — enumerate all reachable scalar/enum paths through the lens:

```ts
const projection = projectLens(lens);
const lensAnchor = lens.model;
const paths: string[] = [];
for (const [dottedPath, visit] of Object.entries(projection)) {
  const prefix = dottedPath === lensAnchor ? '' : `${dottedPath.slice(lensAnchor.length + 1)}.`;
  for (const [field, entry] of Object.entries(visit.fields)) {
    if (entry.kind === 'scalar' || entry.kind === 'enum') paths.push(`${prefix}${field}`);
  }
}
```

For one path without materializing the whole projection, use `walkLensPath`
(below). It runs the same per-visit composition `validateRuleInLens` gates with.

### `walkLensPath(lens, path)` — one path, verified hop by hop

```ts
import { walkLensPath } from '@inixiative/json-rules';

const walk = walkLensPath(narrowing, 'posts.author.name');
// { outcome: 'resolved', hops: [...], terminal: LensPathHop, jsonSubPath: [] }
// { outcome: 'hidden' | 'missing' | 'pastScalar', index: number, hops: [...] }
```

The per-path counterpart of `projectLens`: the walk `validateRuleInLens`
gates a rule's `field` with, exposed for consumers that resolve paths of their
own — template tokens, loop bindings, presence guards. It verifies as it walks:
every hop is checked against the narrowing at that visit, so `hidden` is a
column the model has but the narrowing does not expose there, `missing` a
column (or model) the map does not have, `pastScalar` a segment after a scalar.
A path that continues below a Json column resolves at the column with the
remainder in `jsonSubPath`, the same boundary `check`/`toPrisma`/`toSql`
resolve at evaluation time. Each hop carries its `FieldMapEntry`, so a consumer
reads kind, list-ness and requiredness off the walk instead of re-walking the
map.

### `projectLens(lens, { by: 'model' })` — the leak-safe surface, as a Lens

`projectLens` returns a path-keyed *view* — the graph is flattened away. When
you need the narrowed schema *as a navigable graph* (maps intact) — e.g. to hand
a builder the total set of models/fields/enum values it may draw from —
`projectLens(…, { by: 'model' })` returns a **Lens**, not a projection:

```ts
import { projectLens } from '@inixiative/json-rules';

const surface = projectLens(narrowing, { by: 'model' }); // a Lens — maps intact, navigable
```

It is the **leak-safe server→client surface**. A field appears on a model iff
it is visible on *at least one* reachable, narrowed path — root applied at the
anchor, path-specific narrowing along declared relation paths, `mapDefaults`
everywhere else, unioned per model. Fields hidden on every path (including those
hidden only by `root`) are absent, so it never exposes the raw, un-narrowed lens.
`where` (data scope) is dropped, and the emitted enum registry carries only
exposed values. The traversal is cycle-safe, so recursive schemas
(`User → Org → members(User) → …`) terminate.

> **Lens vs Projection.** Both derive from a lens, but they are different shapes:
> a **Lens** keeps its maps (the model→field→model graph) and is navigable; a
> **Projection** (`projectLens`) is a path-keyed read that has flattened the
> graph away. `projectLens(lens, { by: 'model' }): Lens`; `projectLens(lens): Projection`.
> Pair them when both navigation *and* per-path divergence matter.

> **Trust boundaries.** `projectLens(…, { by: 'model' })` strips `where` because the client never
> executes the rule. A server→subtenant handoff is different: the subtenant *does*
> execute and must inherit the tenant's `where` scope floor and per-path narrowing,
> narrowing only further (never widening). That where-preserving collapse is a
> separate planned primitive (`seal`); do not use `projectLens(…, { by: 'model' })` for it.

## 11. Describe-and-validate vs deny-at-execution

The lens is your **SDK contract**. The narrowing is the description of what the
caller may say. The flow is:

1. **Validate** the incoming rule with `validateRuleInLens`. Reject anything
   that touches a narrowed-away field, a denied enum value, or an
   unresolvable path. This is the security boundary.
2. **Apply** the lens with `narrowRule` to inject the where clauses at their
   proper anchors.
3. **Execute** the composed rule with `toPrisma` / `toSql` / `check`.

To *classify* a rule before executing — which sources it touches, whether it
crosses a bridge, and which targets can run it — use `describeRule(rule, lens)`.
It returns `{ sources, bridgesCrossed, supportedTargets, errors }`, where `errors`
is the lens gate's `ValidationIssue[]` (`{ path, message, code }`). A
bridge-crossing rule is `check()`-only (no cross-source joins), and windowing
(including a narrowed `all`'s `filter`) restricts targets further. `describeRule` is for routing/UX (pick an executor,
badge a rule); `validateRuleInLens` remains the security gate.

```ts
import {
  describeRule,
  executePrismaPlan,
  narrowRule,
  toPrisma,
  validateRuleInLens,
} from '@inixiative/json-rules';

const gate = validateRuleInLens(userRule, narrowing);
if (!gate.ok) throw new HttpError(400, gate.errors);

const composed = narrowRule(userRule, narrowing);
if (!describeRule(composed, narrowing).supportedTargets.includes('toPrisma')) {
  // e.g. a narrowed `all`: fetch under the lens and evaluate with check()
}
const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
const where = await executePrismaPlan(plan, { post: prisma.post });
return prisma.user.findMany({ where });
```

`toPrisma` / `toSql` / `check` operate against the **base lens / FieldMap** —
they're *not* the security boundary. They don't know about narrowing chains;
they only see the composed rule they're given. If you skip
`validateRuleInLens` or skip `narrowRule`, the executor will happily run an
unnarrowed rule. Treat the two-step (validate → apply) as the bottleneck for
every rule entering execution.

## 12. Migration

### To 3.0

3.0 renamed the lens API (`applyLens` is `narrowRule`, `checkRuleAgainstLens` is
`validateRuleInLens`, `projectByPath` is `projectLens`, and so on). The full table is
in the [CHANGELOG](../CHANGELOG.md) under 3.0.0.

### From v2.1 to v2.2

The shape changed; composition didn't. `LensNarrowing.where` and the
dual-purpose `maps` dictionary are gone. Two top-level siblings replace them:
`root` (path-specific anchor tree) and `mapDefaults` (per-map applies-everywhere).
Side-by-side:

```ts
// 2.1
{
  parent: lens,
  where: rootWhere,
  maps: {
    prisma: {
      models: { Inquiry: { picks, relations: { ... } } },
      defaults: { enums: { Status: { omits: ['draft'] } } },
    },
  },
}

// 2.2
{
  parent: lens,
  root: { picks, where: rootWhere, relations: { ... } },
  mapDefaults: {
    prisma: { enums: { Status: { omits: ['draft'] } } },
  },
}
```

`MapNarrowing` was removed from public exports. `validateNarrowing` also tightens
enum strictness — same monotonic-restriction rule that already applied to
picks/omits now applies to per-field `enumPicks/enumOmits` across same-layer +
ancestor model-wide defaults and ancestor's same-position narrowing.

### From v2.0 to v2.1

Two breaking changes at the type level. Code changes are mechanical.

### `FieldMap` shape: now `{ models, enums? }`

Old:

```ts
// v2.0 — FieldMap was Record<string, ModelEntry>
type FieldMap = Record<string, ModelEntry>;

const map: FieldMap = {
  User: { fields: { ... } },
  Post: { fields: { ... } },
};
map['User'];        // works
map.User.fields;    // works
```

New:

```ts
// v2.1 — FieldMap is { models, enums? }
type FieldMap = {
  models: Record<string, ModelEntry>;
  enums?: Record<string, readonly string[]>;
};

const map: FieldMap = {
  models: {
    User: { fields: { ... } },
    Post: { fields: { ... } },
  },
  enums: { UserRole: ['admin', 'member'] },
};
map.models['User'];      // access via .models
map.models.User.fields;  // access via .models
```

Find/replace pattern: anywhere you accessed `map[X]` or `map[mapName][X]`,
change to `map.models[X]` / `map.models[X]`. `FieldMapSet`'s outer shape
(`{ maps, bridges? }`) is unchanged.

This was required to give each `FieldMap` its own enum registry (multi-source
schemas can't share an enum namespace), and to leave room for future
schema-level additions.

### `LensNarrowing.constrains` → `LensNarrowing.where`

Same shape, renamed. The name reflects the filter-first semantic explicitly:
it's a SQL-like `where` clause that scopes which rows are in scope, not a
generic constraint. (Note: in 2.2 this moved again to `root.where` — see the
2.1→2.2 migration above.)

Old (2.0):

```ts
const n: LensNarrowing = {
  parent: lens,
  maps: { prisma: { models: { ... } } },
  constrains: { field: 'deletedAt', operator: Operator.isEmpty },
};
```

New (2.1):

```ts
const n: LensNarrowing = {
  parent: lens,
  maps: { prisma: { models: { ... } } },
  where: { field: 'deletedAt', operator: Operator.isEmpty },
};
```

Find/replace pattern (for the 2.0→2.1 step): `constrains:` → `where:` in
narrowing declarations.

While you're touching narrowings, this is the right time to move
single-purpose scopes from the root-anchored `where` to
`mapDefaults[X].models[M].where` (anchors at every visit of M in map X) —
*unless* you specifically want root-only behavior. Most "soft-delete
everywhere" scopes were getting root anchoring under v2.0 and silently
producing wrong queries under nested array operators. v2.1+'s anchored
composition makes the right behavior available; you have to opt in by
putting the where on the right anchor layer.

## 13. End-to-end worked example

A multi-tenant SaaS. `User` has `Post`s. Server policy: every read scoped to
the current tenant; soft-deleted posts never visible. AI authors a rule and
the server runs it.

### Lens

```ts
import { createLens } from '@inixiative/json-rules';
import type { FieldMap } from '@inixiative/json-rules';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id:        { kind: 'scalar', type: 'String' },
        tenantId:  { kind: 'scalar', type: 'String' },
        posts:     { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id:        { kind: 'scalar', type: 'String' },
        tenantId:  { kind: 'scalar', type: 'String' },
        published: { kind: 'scalar', type: 'Boolean' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        authorId:  { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const lens = createLens({
  maps: { prisma: map },
  mapName: 'prisma',
  model: 'User',
});
```

### Server-side narrowing

```ts
import type { LensNarrowing } from '@inixiative/json-rules';
import { Operator } from '@inixiative/json-rules';

const buildNarrowing = (currentTenantId: string): LensNarrowing => ({
  parent: lens,
  mapDefaults: {
    prisma: {
      models: {
        User: {
          where: { field: 'tenantId', operator: Operator.equals, value: currentTenantId },
        },
        Post: {
          where: {
            all: [
              { field: 'tenantId', operator: Operator.equals, value: currentTenantId },
              { field: 'deletedAt', operator: Operator.isEmpty },
            ],
          },
        },
      },
    },
  },
});
```

### AI-authored rule

"Users with at least one published post":

```ts
const userRule = {
  field: 'posts',
  arrayOperator: 'any',
  condition: { field: 'published', operator: Operator.equals, value: true },
};
```

### Validate

```ts
import { validateRuleInLens } from '@inixiative/json-rules';

const narrowing = buildNarrowing('tenant-42');
const gate = validateRuleInLens(userRule, narrowing);
// { ok: true, errors: [] }
```

### Apply

```ts
import { narrowRule } from '@inixiative/json-rules';

const composed = narrowRule(userRule, narrowing);
// {
//   all: [
//     { field: 'tenantId', operator: 'equals', value: 'tenant-42' },  // root User where
//     {
//       field: 'posts',
//       arrayOperator: 'any',
//       condition: {
//         all: [
//           // Post.where, ANDed in
//           {
//             all: [
//               { field: 'tenantId', operator: 'equals', value: 'tenant-42' },
//               { field: 'deletedAt', operator: 'isEmpty' },
//             ],
//           },
//           // original user condition
//           { field: 'published', operator: 'equals', value: true },
//         ],
//       },
//     },
//   ],
// }
```

The inner condition reads: "some post is in scope (this tenant, not deleted)
*and* published", the intent the AI was expressing, applied to the rows the
lens admits.

### Execute

```ts
import { executePrismaPlan, toPrisma } from '@inixiative/json-rules';

const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
const where = await executePrismaPlan(plan, { post: prisma.post });
// { AND: [
//   { tenantId: { equals: 'tenant-42' } },
//   { posts: { some: { AND: [
//     { AND: [{ tenantId: { equals: 'tenant-42' } }, { deletedAt: { equals: null } }] },
//     { published: { equals: true } },
//   ] } } },
// ] }

const users = await prisma.user.findMany({ where });
```

The Prisma `where` carries the tenant predicate at the root and the Post grant
inside `posts.some`, so the database returns only users with a published post
that is in scope.

### The same rule with `all`

"Every post is published" (`arrayOperator: 'all'`) narrows differently: the
Post grant becomes the array rule's window `filter` (section 4), so deleted and
cross-tenant posts are dropped before the `all` runs. Neither compiler
expresses a window `filter`, so `describeRule(composed, narrowing).supportedTargets`
is `['check']` and `toPrisma` throws. Fetch the users with their posts under the
lens and evaluate the composed rule with `check()`:

```ts
import { check } from '@inixiative/json-rules';

const composedAll = narrowRule({ ...userRule, arrayOperator: 'all' }, narrowing);
check(composedAll, {
  tenantId: 'tenant-42',
  posts: [
    { tenantId: 'tenant-42', published: true, deletedAt: null },
    { tenantId: 'tenant-42', published: false, deletedAt: '2026-01-01' }, // deleted: filtered out
  ],
}); // true
```
