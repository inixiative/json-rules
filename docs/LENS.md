# Lens v2.2 — deep-dive guide

> The Lens primitive at v2.2. For library basics (operators, `check()`,
> `toPrisma()`, `toSql()`, bridges, multi-source data evaluation), see the
> [README](../README.md).

## 1. Why Lens exists

AI-authored rules over multi-tenant data need a safety boundary that's
*declarative*, not application code. If the SDK or the model can see every
field on every model and write a `where: tenantId = "other-tenant"` predicate,
no amount of code review will stop the next prompt from doing it. Lens is that
boundary: a schema-aware view layer that says, declaratively, "this is what's
visible, and these are the rows in scope, *anywhere this model is reached.*"
`checkRuleAgainstLens` is the gatekeeper. `applyLens` is the composer that
injects the scope where clauses at the *right anchor points* in the rule tree
so the resulting query/check operates only on rows the lens admits.

## 2. Two kinds of narrowing

The most important thing to internalize: a `LensNarrowing` contains two distinct
kinds of narrowing, with different concerns. Mixing them up is the fastest way
to write a lens that "works" but leaks scope.

### Schema narrowing — what's *visible*

`picks` / `omits` / `enumPicks` / `enumOmits` control the **type surface**. The
SDK, the AI, the OpenAPI emission — none of them can *mention* a narrowed-away
field or enum value. `projectByPath(lens)` produces the path-keyed projection
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
will be rejected by `checkRuleAgainstLens` (the field isn't in the projected
surface). The scope narrowing leaves the field visible but guarantees that every
rule executed against the lens runs over non-deleted rows.

## 3. The three anchor layers for `where`

The whole point of v2.1's anchored composition is that a `where` does not
always belong at the *root* of the rule. It belongs anchored to the model it
describes — and `applyLens` finds that anchor point and injects it there.

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

This is the part of v2.1 that justifies the rewrite. Consider:

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

### Filter-first via implication — right

`applyLens` rewrites the `all` case using NOT-or-original (logical implication):

```ts
{
  field: 'comments',
  arrayOperator: 'all',
  condition: {
    any: [
      { field: 'deletedAt', operator: 'notEmpty' },          // NOT(scope)
      { field: 'body', operator: 'matches', value: 'foo' },  // user
    ],
  },
}
```

This reads: "every comment is either deleted *or* matches foo." Equivalently:
"every non-deleted comment matches foo." Filter-first restored.

### Truth table

For a single row, `comments.all(body matches foo)` with
`Comment.where = deletedAt isEmpty`:

| `deletedAt` | `body matches foo` | Naive `all(scope ∧ user)` | Filter-first `all(¬scope ∨ user)` |
| --- | --- | --- | --- |
| empty (in scope) | match | row passes | row passes |
| empty (in scope) | no match | row fails → `all` fails | row fails → `all` fails |
| non-empty (deleted) | match | row fails → `all` fails | row passes (vacuous) |
| non-empty (deleted) | no match | row fails → `all` fails | row passes (vacuous) |

The filter-first column matches the intuitive reading: deleted rows simply
don't participate. The naive column rejects the user's data over rows they
weren't even asking about.

### `negate` helper and its limits

`applyLens` calls an internal `negate()` to produce the `¬scope` half. `negate`
reuses *existing negative operators* in the DSL — no new `not` primitive:

- `equals ↔ notEquals`, `in ↔ notIn`, `contains ↔ notContains`,
  `matches ↔ notMatches`, `between ↔ notBetween`,
  `isEmpty ↔ notEmpty`, `exists ↔ notExists`
- Date: `before ↔ onOrAfter`, `after ↔ onOrBefore`, `between ↔ notBetween`,
  `dayIn ↔ dayNotIn`
- ArrayOps: `any ↔ none`, `all` inverts to `any` with a negated inner,
  `atLeast n ↔ atMost n-1`, `empty ↔ notEmpty`
- Compound: De Morgan's laws on `all`/`any`; `if/then/else` inverts the branches

There is **no inverse** for `startsWith`, `endsWith`, or `exactly`. If a
`where` clause uses any of these and lands under an `arrayOperator: 'all'`,
`applyLens` throws clearly with a fix hint. Rewrite the where using an
invertible operator (e.g. `matches /^admin:/` instead of `startsWith 'admin:'`).

The other array operators (`any`, `none`, `atLeast`, `atMost`, `exactly`) and
`aggregate.condition` use plain AND injection — the filter-first semantic is
already preserved by the operator's own meaning.

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
defaults*. A chained narrowing that re-picks an ancestor-omitted field throws:

```text
validateNarrowing:
root.picks: 'password' was omitted by ancestor
```

The strict check means you find bad lens code at construction, not at query
time with a silently empty result.

`projectByPath()` is the projection primitive (added in 3.0, replacing the
pre-3.0 `projectNarrowing` which returned a flat model-keyed `FieldMapSet`).
The pre-3.0 shape couldn't represent "User looks different at `sourceUser`
vs `targetUser`" — two sibling relation paths targeting the same model
collapsed into a single accumulator. `projectByPath` returns
`Map<dottedPath, ProjectedVisit>` so each declared path keeps its own resolved
narrowing. See section 10 for the API.

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

`projectByPath` materializes the per-field allowed set onto `FieldMapEntry.values`
on each visited field at each path, with all three enum narrowing layers
composed. The consumer reads it directly:

```ts
const projection = projectByPath(lens);
const allowed = projection.get('User')?.fields.role?.values ?? [];
```

Each path key gets its own resolved field set, so path-specific enum divergence
is preserved (e.g. `User.role` picks `['admin']` at root and `['member']` via
`posts.author` — each path's allowed values stand on their own, no leakage).

`checkRuleAgainstLens` rejects rule values not in the resolved set — leaf
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
};

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

### `checkRuleAgainstLens(rule, lens)` — validate at the API boundary

This is the *gatekeeper*. Call it on every user-authored rule before doing
anything else with it.

```ts
import { checkRuleAgainstLens } from '@inixiative/json-rules';

const userRule = {
  field: 'posts',
  arrayOperator: 'all',
  condition: { field: 'published', operator: Operator.equals, value: true },
};

const check = checkRuleAgainstLens(userRule, narrowing);
// { ok: boolean, violations: Array<{ path, reason }> }

if (!check.ok) {
  return res.status(400).json({ violations: check.violations });
}
```

It walks the rule AST per-path, resolves every field against the projected
surface at the right visit, and reports:

- field paths that don't resolve through the narrowed lens
- enum values not in the allowed set
- nested-condition fields validated against the *relation target*, not the
  lens root

### `applyLens(rule, narrowing)` — compose with scope

Once a rule has passed the gate, run it through `applyLens` to get the
**composed rule** with all where clauses injected at their proper anchors. Pass
the result to `check()`, `toPrisma()`, or `toSql()`.

```ts
import { applyLens, toPrisma } from '@inixiative/json-rules';

const composed = applyLens(userRule, narrowing);
// composed now contains the user rule + tenantId/deletedAt wheres anchored
// at every User and Post visit, with `all` operators rewritten filter-first.

const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
// plan.steps[plan.steps.length - 1].where is your Prisma where clause.
```

### `projectByPath(lens)` — path-keyed projection

```ts
import { projectByPath } from '@inixiative/json-rules';

const projection = projectByPath(narrowing);
// Map<dottedPath, ProjectedVisit>
//   key:   dotted path from the lens anchor, e.g. "Post", "Post.author", "Post.editor"
//   value: { mapName, modelName, fields, whereClauses }
```

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
const projection = projectByPath(lens);
const lensAnchor = lens.model;
const paths: string[] = [];
for (const [dottedPath, visit] of projection) {
  const prefix = dottedPath === lensAnchor ? '' : `${dottedPath.slice(lensAnchor.length + 1)}.`;
  for (const [field, entry] of Object.entries(visit.fields)) {
    if (entry.kind === 'scalar' || entry.kind === 'enum') paths.push(`${prefix}${field}`);
  }
}
```

For the runtime per-path narrowing facts (without materializing the whole
projection), `resolveVisit(policy, mapName, modelName, relPath)` returns the
same composition for a single visit. `checkRuleAgainstLens` uses it
internally — it's the path-aware authority for "is this rule field allowed."

## 11. Describe-and-validate vs deny-at-execution

The lens is your **SDK contract**. The narrowing is the description of what the
caller may say. The flow is:

1. **Validate** the incoming rule with `checkRuleAgainstLens`. Reject anything
   that touches a narrowed-away field, a denied enum value, or an
   unresolvable path. This is the security boundary.
2. **Apply** the lens with `applyLens` to inject the where clauses at their
   proper anchors.
3. **Execute** the composed rule with `toPrisma` / `toSql` / `check`.

```ts
import { checkRuleAgainstLens, applyLens, toPrisma } from '@inixiative/json-rules';

const check = checkRuleAgainstLens(userRule, narrowing);
if (!check.ok) throw new HttpError(400, check.violations);

const composed = applyLens(userRule, narrowing);
const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
return prisma.$transaction(plan.steps.map(executeStep));
```

`toPrisma` / `toSql` / `check` operate against the **base lens / FieldMap** —
they're *not* the security boundary. They don't know about narrowing chains;
they only see the composed rule they're given. If you skip
`checkRuleAgainstLens` or skip `applyLens`, the executor will happily run an
unnarrowed rule. Treat the two-step (validate → apply) as the bottleneck for
every rule entering execution.

## 12. Migration

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

```ts
const userRule = {
  field: 'posts',
  arrayOperator: 'all',
  condition: { field: 'published', operator: Operator.equals, value: true },
};
```

### Validate

```ts
import { checkRuleAgainstLens } from '@inixiative/json-rules';

const narrowing = buildNarrowing('tenant-42');
const check = checkRuleAgainstLens(userRule, narrowing);
// { ok: true, violations: [] }
```

### Apply

```ts
import { applyLens } from '@inixiative/json-rules';

const composed = applyLens(userRule, narrowing);
// Composed AST (filter-first under `all`):
// {
//   all: [
//     { field: 'tenantId', operator: 'equals', value: 'tenant-42' },  // root User where
//     {
//       field: 'posts',
//       arrayOperator: 'all',
//       condition: {
//         any: [
//           // negate(Post.where) — De Morgan over the `all` compound
//           {
//             any: [
//               { field: 'tenantId', operator: 'notEquals', value: 'tenant-42' },
//               { field: 'deletedAt', operator: 'notEmpty' },
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

The rewritten inner condition reads: "every post is either out-of-scope (wrong
tenant or deleted) *or* published." Equivalently: "every in-scope post is
published" — the intent the AI was expressing, applied to the rows the lens
admits.

### Execute

```ts
import { toPrisma } from '@inixiative/json-rules';

const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
const where = plan.steps[plan.steps.length - 1].where;

const users = await prisma.user.findMany({ where });
```

The resulting Prisma `where` carries the tenant predicate at the root and the
filter-first `all` semantic inside the `posts.every` clause, so the database
itself returns only users whose in-scope posts are all published — never
admitting deleted or cross-tenant rows into the check.
