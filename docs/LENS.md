# Lens deep-dive guide

> The Lens primitive as of 3.4. For library basics (operators, `check()`,
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

### Layers only get darker

A lens is a stack of filters. Each layer may only narrow what the layers above it show, never
widen it, so layers compose and the result is monotonic: adding a layer can only take away.
Stacking layers is the point.

One stack answers every posture, and every layer filters every posture:

| Posture | Calls |
| --- | --- |
| reason | the gate: `validateRuleInLens`, and `toPrisma` / `toSql` with `{ lens }` |
| fetch | `toPrisma(true, { lens })` + `toLensSelect` + `projectRows` |
| read | `readLensValue` |

Postures may differ in what they see: grants reason over columns a viewer never gets back, and
`projectRows({ keepGrantColumns: true })` output is for an in-memory re-check only.

Each layer works on its parent's projection: it may only mention — pick, omit, restate, grant
on — what its parent shows. The base lens is the menu: every column, no relation turned on.

What one layer may do, given the layers above it (layer 1 is the first narrowing over the base):

| Part | Composes | A layer may |
| --- | --- | --- |
| `picks` / `omits` / `enumPicks` / `enumOmits` | intersect (omits union) | only hide more; naming what an ancestor hid is an error. `picks` names columns only (a relation in it is `wrong_kind`); `omits` may name a relation, beside `picks` too |
| `relations` (turning on) | exposed₁ = layer 1 turns it on ∧ ¬ layer 1 hides it; exposedₖ = exposedₖ₋₁ ∧ ¬ layer k hides it | layer 1: turn on any relation, along the path (`root.relations`) or at a model default (`mapDefaults…models.M.relations`). Later layers: hide it with `omits`, or restate one the parent shows to narrow that hop (else `not_visible`); a restatement hides nothing else |
| model-default relations | a tree under each spelled node: each model once, at its nearest reach (ties: earlier parent, then field order) | spell under `root.relations` to reach a model another way; every posture walks the same tree |
| `where` grants | AND at their anchor | only add. A later layer's grant is checked by one function — the gate over its parent's surface, every hop and the column at its end — at every visit it applies to (the shown visits, and the ones a layer-1 grant or source crosses), by `validateNarrowing` and by every runtime posture alike. Layer 1's may read any relation on the schema; a later layer's only what its parent shows — refused by `validateNarrowing`, and at runtime every posture throws rather than apply it. A bare value `path` reads the root row, so only `root.where` may hold one; a relation grant or a model default uses a literal, a bind, or a `$` scope ref (`invalid_value_source`, and a runtime throw) |
| `sources` `where` / `label` / `groupBy` | `where` ANDs; a later `label` / `groupBy` wins | the `where` is a grant (as above); a label or axis reads only relations shown at each visit the source is projected, and columns every other layer shows (only the layer that set the value in force is exempt from its own hiding) |
| `from: 'mapDefaults'` pointers | — | escape only their own layer's path grants; every other layer's still apply |

## 2. Two kinds of narrowing

The most important thing to internalize: a `LensNarrowing` contains two distinct
kinds of narrowing, with different concerns. Mixing them up is the fastest way
to write a lens that "works" but leaks scope.

### Schema narrowing — what's *visible*

`picks` / `omits` / `enumPicks` / `enumOmits` control the **type surface**. The
SDK, the AI, the OpenAPI emission — none of them can *mention* a narrowed-away
field or enum value. `projectLens(lens)` produces the path-keyed projection
that reflects this surface, with each shown path getting its own resolved
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

### Relations — fields, off by default

A relation is a field, and it is off until the first narrowing over the base lens turns it on.
A bare lens reads its anchor model's own columns and nothing else. Without this, a lens that
shows `org` would hand a rule the full map any model reaches — `org.parent.users.org…`, back and
forth through every relation.

Two ways to turn one on, both through the relation object, never `picks`:

```ts
const n: LensNarrowing = {
  parent: lens, // anchor: User
  // along the path: org at the root, parent at org
  root: { relations: { org: { relations: { parent: {} } } } },
  // at the model default: users wherever Org is visited
  mapDefaults: { prisma: { models: { Org: { relations: { users: {} } } } } },
};
// accepted: org.name, org.parent.name, org.users.name, { field: 'org', operator: 'exists' }
// refused (not_in_lens, walkLensPath 'hidden'): posts.title, org.parent.parent.name
```

The relation object carries that hop's narrowing — `where`, `picks` / `omits` of the target's
columns, further `relations`. On a model default it narrows the hop wherever the model is
visited, and may nest (`Org.relations.users.relations.posts` turns posts on below Org.users only).

**The model defaults grow a tree.** From each spelled node — the anchor, and every path spelled
under `root.relations` — the first narrowing's model-default turn-ons are followed breadth-first,
and each model is included at most once: at its nearest reach (fewest hops), ties going to the
earlier parent and then to the relation declared first in the map. A model already on the
spelled path, or earlier in that tree, is not entered again. Anything outside the tree is reached
by spelling it under `root.relations`; a spelled node is always followed and grows its own tree.
A model default's nested relation object (`A.relations.m.relations.r`) applies wherever the edge
it hangs from is crossed — along a tree edge or a spelled one — and nowhere else.

```ts
// A has p → P and q → Q; both P and Q have t → T. All turned on at the defaults:
mapDefaults: { app: { models: { A: { relations: { p: {}, q: {} } },
                                 P: { relations: { t: {} } }, Q: { relations: { t: {} } } } } }
// T is reached once, by p (declared before q): 'p.t.id' resolves, 'q.t.id' is hidden.
// Spell it to reach it another way:
root: { relations: { q: { relations: { t: {} } } } }      // now 'q.t.id' resolves too
```

Anchored at User with `User.org`, `User.posts`, `Org.users`, `Org.parent` and `Post.author` on at
the defaults: `org.name` and `posts.title` resolve; `org.users`, `org.parent` and `posts.author`
do not (User and Org are already in the tree). `org: { relations: { users: {} } }` spells
`org.users`, and below it the defaults grow again (`org.users.posts`). Every posture walks this
same tree — the gate, `walkLensPath`, `readLensValue`, `lensVisit`, `narrowRule`, `{ lens }`
compiles, `projectLens` (both modes), the sources, `validateNarrowing` and `toLensSelect` — so
they agree exactly, and each stays within (spelled nodes × models) visits. The trees are kept on
the first narrowing, keyed by the base lens it stands on and its model defaults, so a narrowing
edited or re-parented in place grows fresh ones; a field map edited in place is not seen — build
the lens anew (`createLens`) after changing a map.

What turning on governs:

- **Everything a rule reads.** A `field`, a value-side `path` or `$` ref, an offset or magnitude
  ref, an `orderBy` / aggregate field, and presence tests (`exists` / `notExists`) on the relation
  itself. A relation that is off is `hidden` — `walkLensPath` reports it, `readLensValue` refuses
  with reason `hidden`, the gate with `not_in_lens`, and `toPrisma` / `toSql` `{ lens }` throw.
- **What a lens exposes and fetches.** `projectLens` lists a relation field only where it is on and
  follows only those; `toLensSelect` opens only those, and `projectRows` keeps only those.
- **Source labels and axes.** A dotted `label` or `groupBy` crosses only relations shown at every
  visit where the source is projected — a model source in `mapDefaults` included.

Later layers:

- **Narrow, never turn on.** A later layer may `omits: ['org']` (the next layer can't turn it back
  on), or restate `relations.org = { where }` to add a grant on that hop — a restatement hides
  nothing else. Naming a relation its parent doesn't show is `not_visible`, and does nothing at
  runtime.
- **Grant on what the parent shows.** A later layer's `where` (and source eligibility `where`)
  may cross only relations its parent shows; otherwise a delegate's grant would probe what it
  can't see. Layer 1's grants read the schema. `validateNarrowing` reports a grant that crosses
  more, and every runtime posture (the gate, `narrowRule`, `{ lens }` compiles, `toLensSelect`,
  `projectRows`, `readLensValue`, the sources) throws instead of applying it.
- **A source `where` narrows as a rule.** It is a grant on the options and a surface a viewer
  reasons over, so each one is narrowed under the whole lens as `narrowRule` narrows a rule: an
  option never comes through a row any layer hides. A later layer's grant on a relation a source
  reads thereby applies there — and is checked there, like any other.
- **Sources across a bridge.** A source whose `where`, `label` or an axis reads across a bridge
  has no database form and no fetch form (`toLensSelect` selects no bridge): `toSourceQueries`
  returns it with `prisma: null` and an `sql.error` naming the path, and `materializeSources`
  materializes it from rows the caller supplies with the far side inline under its bridge field
  (a bridged pointer too). Rows without that side throw.
- **One posture code path.** `validateNarrowing` runs the postures the runtime runs — the
  projection by path and by model, `lensVisit` at every shown path, the source plans, the fetch
  select, and a rule reaching each shown visit narrowed — and reports each `LensRefusal` they
  raise as an issue. Nothing compiles there, so no binding, clock or literal is read: an unbound
  lens validates exactly as its bound runtime refuses (`ok` ⇔ no posture refuses).
- **A grant reads its own row.** A scope ref that climbs out of the grant (`$$.` at its top,
  `$$$.` one array down) is `scope_out_of_bounds` in `validateNarrowing`, and every posture throws.
- **A bare `path` in a grant reads the root row.** Only `root.where` stands on it; in a relation
  grant, a model default or a source's eligibility `where`, use a literal, a bind, or a `$` scope
  ref — otherwise `validateNarrowing` reports `invalid_value_source` and every posture throws.

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
- Lens scope: `root.relations.comments` declared, `mapDefaults.prisma.models.Comment.where = { deletedAt isEmpty }`.
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

`toPrisma` compiles a window that is only a `filter` (no `orderBy` / `take` / `skip`) by folding
it into the rule: `all` becomes "no row in scope breaks the condition", through the exact
complement of the condition (NULL fields included); `any`, `none`, counts and aggregates take
`filter AND condition`. A `filter` beside `orderBy` / `take` / `skip` stays check-only, and
`toSql` compiles no relation arrays.

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
that the grant rides a window `filter`: `toPrisma` folds a filter-only window into the rule (see
above), and `toSql`, which compiles no relation arrays, refuses it — `describeRule` reports
`['check', 'toPrisma']`.

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
- `relations`: turned on by the first narrowing only (its path tree and model defaults); every
  layer's `omits` hides one. A later layer's relation object restates a relation its parent shows
  to narrow that hop, and hides nothing else.

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

Relations work the same way: a later layer that names a relation its parent doesn't show is an
error, and `picks` naming a relation is one too.

```ts
// withOrg = { parent: lens, root: { relations: { org: {} } } }
validateNarrowing({ parent: withOrg, root: { relations: { org: { relations: { parent: {} } } } } });
// { ok: false, errors: [{ path: 'root.relations.org.relations', code: 'not_visible', ... }] }
validateNarrowing({ parent: lens, root: { picks: ['id', 'org'] } });
// { ok: false, errors: [{ path: 'root.picks', code: 'wrong_kind', ... }] }
```

The codes are `not_in_lens`, `not_visible`, `conflicting_selection`, `wrong_kind`,
`value_not_allowed`, `invalid_source` and `invalid_binding`, plus the lens gate's own codes for a
`where`.

The strict check means you find bad lens code at construction, not at query
time with a silently empty result.

`projectLens()` is the projection primitive. A model-keyed projection can't
represent "User looks different at `sourceUser` vs `targetUser`": two sibling
relation paths targeting the same model collapse into one entry. `projectLens`
returns a plain `Record<dottedPath, ProjectedVisit>`, so each shown path keeps
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

/** Narrowing applied wherever a model appears (intrinsic to the model). Its `relations` turn
 *  relations on wherever the model is visited (first narrowing only). */
type ModelDefaultNarrowing = {
  picks?: string[];                                       // schema: keep only these fields
  omits?: string[];                                       // schema: drop these fields
  enumPicks?: Record<string, readonly string[]>;          // schema: per-field enum allow-list
  enumOmits?: Record<string, readonly string[]>;          // schema: per-field enum deny-list
  where?: Condition;                                      // data: row-level filter (filter-first)
  sources?: Record<string, SourceEntry>;                  // per-field option sources (see README)
  relations?: Record<string, ModelNarrowing>;             // turn these on wherever the model is visited
};

/** A `sources` entry: a bare eligibility Condition, a spec with a label and/or groupBy, or —
 *  on a path — a pointer to the model's own source in mapDefaults (see README, "Two kinds of
 *  source"). */
type SourceEntry =
  | Condition
  | { where?: Condition; label?: string; groupBy?: string | string[] } // at least one key
  | { from: 'mapDefaults'; where?: Condition };                         // offers the model source

/** Narrowing for a model at a specific traversal path. Adds relations. */
type ModelNarrowing = ModelDefaultNarrowing & {
  relations?: Record<string, ModelNarrowing>;             // the relations a rule may cross from here
};

/** Narrowing for an enum *type* (anywhere the enum is referenced in this map). */
type EnumNarrowing = {
  picks?: readonly string[];
  omits?: readonly string[];
};

/** Applies-everywhere narrowings for one map — per-model + per-enum-type. */
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
  root: { relations: { posts: {} } }, // rules may cross User.posts, and nothing else
  mapDefaults: {
    prisma: {
      models: {
        // every User row visited, anywhere, must match tenantId
        User: {
          omits: ['deletedAt'], // schema: hide the field too
          where: { field: 'tenantId', operator: Operator.equals, bind: 'tenantId' },
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

### Storing a lens

A composed lens holds its layers as nested objects; a database holds them as records.
`storeLens(lens, ids)` writes one `StoredLens` per layer — its `id`, `parents` (every layer it
composes with, the base lens first) and its own part; the base lens is a record with no parents.
To use one, fetch its record and the ids it lists, and `composeLens(id, records)` nests them from
the base down, validating each layer against the ones above it (`validateNarrowing`). A missing
record, a base anywhere but first, or a parent whose own `parents` disagree with the list fails
closed. Re-parenting a stored layer means rewriting the layers below it, whose lists name it.

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
- relations a path crosses that the lens doesn't turn on (`not_in_lens`)
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
// array rule's window `filter`, which toPrisma folds into the rule.

check(composed, userWithPosts);
```

The composed rule compiles like any other:

```ts
import { executePrismaPlan, toPrisma } from '@inixiative/json-rules';

const composed = narrowRule(anyPublishedRule, narrowing);
const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
const where = await executePrismaPlan(plan, { post: prisma.post });
```

`{ lens }` does all of it in one call: the rule gated by the lens (a rule it refuses throws; a
bare value `path` is a root-row column, gated like a field), narrowed by it, and
compiled against its base lens (`getLensRoot`) and that lens's `mapName` / `model`. `toSql` takes it the same way. Passing `lens`
with `map`, `mapName` or `model` throws.

```ts
const plan = toPrisma(anyPublishedRule, { lens: narrowing });
```

### Fetching rows under a lens

`toLensSelect(narrowing, options?)` gives the `findMany` `select` for the rows a lens shows: each
shown visit's visible columns and the relations turned on, and every column a `where` on the way
reads. A relation that is off is not fetched. A to-many
relation carries its grants as its `where`, unless a grant reads that list — a grant reads a list
whole, as the database does. `projectRows(narrowing, rows, options?)` cuts fetched rows to what the
lens shows: hidden columns, and relations that are off or omitted, removed, a row a `where` hides
dropped (a to-one row becomes `null`). With
`keepGrantColumns: true` it keeps the columns those `where`s read, and a hidden to-one row, or a hidden row of a list a grant reads, as
those columns alone, so `check(narrowRule(rule, narrowing), row)` re-tests the grants as the
database does, for any rule the lens admits; that output carries hidden values and is never for a viewer. See the README,
"Fetching Under a Lens".

```ts
const where = await executePrismaPlan(toPrisma(true, { lens: narrowing, now }), prisma);
const rows = await prisma.user.findMany({ where, ...toLensSelect(narrowing, { now }) });
const shown = projectRows(narrowing, rows, { now });
const forRecheck = projectRows(narrowing, rows, { keepGrantColumns: true, now });
```

### `projectLens(lens)` — path-keyed projection

```ts
import { projectLens } from '@inixiative/json-rules';

const projection = projectLens(narrowing);
// Record<dottedPath, ProjectedVisit> — a plain object
//   key:   dotted path from the lens anchor, e.g. "Post", "Post.author", "Post.editor"
//   value: { mapName, model, fields, whereClauses, sources, sourceLabels, sourceGroupBys, sourceFrom }
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

Example — enumerate every scalar/enum path the lens declares:

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
column the model has but the narrowing does not expose there (or a relation it
doesn't turn on there), `missing` a column (or model) the map does not have, `pastScalar` a segment after a scalar.
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
it is visible on *at least one* shown path — root applied at the anchor,
path-specific narrowing and `mapDefaults` along each relation turned on,
unioned per model — and a relation field only where it is on. A model no
relation reaches is absent. A bare lens projects its anchor model's columns
alone; a surface spanning several models (a synthetic root whose relations lead
to each slot) turns each slot on under `root.relations`. Fields hidden on every path (including those
hidden only by `root`) are absent, so it never exposes the raw, un-narrowed lens.
`where` (data scope) is dropped, and the emitted enum registry carries only
exposed values. The model defaults grow a tree (each model once), so recursive
schemas (`User → Org → members(User) → …`) project only as deep as that, or as a
spelled path goes.

> **Lens vs Projection.** Both derive from a lens, but they are different shapes:
> a **Lens** keeps its maps (the model→field→model graph) and is navigable; a
> **Projection** (`projectLens`) is a path-keyed read that has flattened the
> graph away. `projectLens(lens, { by: 'model' }): Lens`; `projectLens(lens): Projection`.
> Pair them when both navigation *and* per-path divergence matter.
>
> **A surface is not a gate.** The Lens `by: 'model'` returns carries maps, not narrowing: used as a
> lens itself it is a bare lens, which declares no relation, so `validateRuleInLens`, `coerceRule`,
> `describeRule` and `{ lens }` compiles against it refuse or skip every relation path. Gate, coerce
> and describe against the narrowing the surface was projected from.

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
3. **Execute** the composed rule with `toPrisma` / `toSql` / `check`. `toPrisma(rule, { lens })`
   and `toSql(rule, { lens })` do all three in one call: a rule the gate refuses throws.

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
  // e.g. a window beyond the extremal case: fetch under the lens and evaluate with check()
}
const plan = toPrisma(composed, { map: lens, mapName: 'prisma', model: 'User' });
const where = await executePrismaPlan(plan, { post: prisma.post });
return prisma.user.findMany({ where });
```

`toPrisma` / `toSql` / `check` are *not* the security boundary. Given a `map`,
they run against the base FieldMap and see only the rule they're given: skip
`narrowRule` and the executor runs an unnarrowed rule. `{ lens }` gates and
narrows for you; with a bare `map`, nothing does. Treat validate → apply (or
`{ lens }`) as the bottleneck for every rule entering execution.

## 12. Migration

### To 3.4

**Relations are off until turned on.** Turn on every relation you cross — in rules, value refs,
source labels and axes, reads and fetches — with `relations`, on the first narrowing over the base
lens: along the path (`root.relations`, one level per hop) or at the model default
(`mapDefaults…models.M.relations`, a tree under each spelled node, each model once at its nearest reach).
Remove
relation names from `picks` (`wrong_kind` now):

```ts
// before: picking org made org.parent.name reachable whenever Org's fields were visible
{ parent: lens, root: { picks: ['id', 'org'] } }
// 3.4
{ parent: lens, root: { picks: ['id'], relations: { org: { relations: { parent: {} } } } } }
```

A later layer can't turn a relation on — move turn-ons to the first narrowing — and its grants
read only what its parent shows. `toLensSelect` and `projectRows` no longer take `rules`, and no
longer fetch or keep a relation that is off.

**`context` is gone.** Caller values are binds (`{ bind }`; `check(…, { bindings })`, `bindRule`
before compiling). A bare `path` is a root-row column on every rail: `check()` reads the row,
`toSql` compiles a column, `toPrisma` a Prisma field reference between columns of the same model
and type, else it throws. `timeZone` is a string or a `{ bind }`.

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
  root: { relations: { posts: {} } },
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
// or, narrowing and compiling in one call: toPrisma(userRule, { lens: narrowing })
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
cross-tenant posts are dropped before the `all` runs. `toPrisma` folds that
filter into the rule — "no post in scope is unpublished" — and `toSql` compiles
no relation arrays, so `describeRule(composedAll, narrowing).supportedTargets` is
`['check', 'toPrisma']`:

```ts
import { check, toPrisma } from '@inixiative/json-rules';

const composedAll = narrowRule({ ...userRule, arrayOperator: 'all' }, narrowing);
toPrisma(composedAll, { map: lens, mapName: 'prisma', model: 'User' }).steps[0].where;
// { AND: [
//   { tenantId: { equals: 'tenant-42' } },
//   { posts: { none: { AND: [
//     { AND: [{ tenantId: { equals: 'tenant-42' } }, { deletedAt: { equals: null } }] },
//     { published: { not: true } },
//   ] } } },
// ] }

check(composedAll, {
  tenantId: 'tenant-42',
  posts: [
    { tenantId: 'tenant-42', published: true, deletedAt: null },
    { tenantId: 'tenant-42', published: false, deletedAt: '2026-01-01' }, // deleted: filtered out
  ],
}); // true
```
