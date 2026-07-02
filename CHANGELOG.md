# Changelog

## 2.12.1 — lens-boundary fixes: hydrated-source option gating + `all`-grant filter-first

**Restore hydrated-source option gating.** `checkRuleAgainstLens` again gates a rule's value against a hydrated source's fetched **`options`** set, not only against an input `values` set. When a consumer folds `sourceValues` onto `field.options` (via `exposedSurface`/`projectByPath`) and re-feeds the exposed surface back into `checkRuleAgainstLens`, a value outside the fetched set is rejected. This was a regression in 2.12.0 (the `options` branch of the value gate was dropped as unreachable — but it's reached by the fold-then-gate consumer flow). Covered by `test/lens.sourceOptionsGating.test.ts`.

**`applyLens` `all`-grant is now filter-first.** A `where` grant under an `arrayOperator: 'all'` is injected into the array rule's window `filter` (dropped before order/take/skip and before the all-check), not realized as a per-row `¬scope ∨ condition` implication. The old implication was unsound two ways: (1) **security** — under a window (`orderBy`/`take`), `check` applied the window to the raw array first, so an out-of-scope row could take the slot and be exempted, bypassing the lens narrowing; (2) it rejected valid data when `negate` of an ordered comparator wasn't a true complement over a missing field. Filter-first fixes both, needs no operator inverse (so a `startsWith` grant no longer throws), and makes such rules `check()`-evaluated (the prefilter overmatches, `check()` narrows — the normal prefilter+check contract). Covered by `test/lens.applyLens.allFilterFirst.test.ts`. See `docs/LENS.md`.

## 2.12.0 — labeled source options, deterministic dates, lens-gate hardening

### Sources: labeled option sets (`options`)

- A `sources` entry now accepts a `SourceSpec` (`{ where?, label? }`) alongside the bare `Condition`; `label` co-selects a sibling column so each option carries a display label. Referenced-model option sets need no special form — declare the source at a relation-traversed narrowing node and it compiles over whatever model that path resolves to.
- The projected/exposed surface exposes a field's selectable set uniformly as `options: { value, label? }[]` (the `<select>` shape), enum fields included (label defaults to the value). The existing `values: string[]` stays as the validation/codegen input; `options` is **additive**.
- `SourceValues.options` (was `values: string[]`) and `SourceQuery.label` carry the label through `sourceQueries` → `exposedSurface`/`projectByPath`.

### Dates: deterministic, timezone-explicit evaluation

- `check()` date comparisons no longer depend on the host machine's timezone. Absolute instants (`Date` objects, epoch numbers, zone-stamped ISO strings) are used as-is; naive values (date-only, zoneless datetimes) are anchored in the evaluation's timezone; `dayIn`/`dayNotIn` compute the weekday in that timezone. **Behavior change / bug fix**: results are now stable across hosts (previously a host with a non-UTC offset could return a different answer for the same rule).
- The anchoring timezone resolves through one seam and is now **bindable**: `DateConfig.timeZone` accepts `string | { bind }` (`TimeZoneConfig`), resolved from `bindings` — precedence bound → literal → `'UTC'`. Per-record (companion-column) zones are documented as a future extension in `docs/TIMEZONE.md`.

### `isEmpty` / `notEmpty`: aligned with the compilers

- `check()` now treats a value as empty iff it is `null`, `undefined`, or `''` — matching `toSql` (`IS NULL OR = ''`) and `toPrisma` (`null | ''`). **Behavior change / bug fix**: a `Date` or a number is no longer "empty" (lodash `isEmpty` reported both as empty, so a soft-delete grant like `deletedAt isEmpty` wrongly passed deleted rows in the in-memory backend).
- `isEmpty`/`notEmpty` are now valid on any nullable field kind (not only `String`), so the documented soft-delete grant validates.

### Lens gate: closes three reference-escape holes

`checkRuleAgainstLens` now enforces what the docs claim ("a rule can't reference outside its lens"):

- Right-side `path:` references are gated the same way the left-side `field` is (a comparison ref must resolve through the narrowed lens) — previously an author could probe a hidden field through an equality/ordering oracle.
- Window `filter` (a full condition) and `orderBy` field refs are validated at the descended relation target.
- `applyLens` injects a related model's `where` grant on **to-one / mid-path** relation hops (e.g. `author.email`), re-rooted under the relation path — previously the grant was silently dropped for the most common relation shape. Where a grant can't be re-rooted unambiguously (a `path` ref, or a to-many hop with no array-operator anchor), `applyLens` **fails closed** (throws) rather than emitting an unenforced grant.

## 2.11.1 — bind resolution: key-presence contract

Resolving a `{ bind }` now distinguishes an **unsupplied** binding from one supplied as nothing — key presence is the contract:

- **Name absent from the `bindings` map → throw** (`check`, and the compilers). A forgotten scope must never silently run; the throw is now precise (key presence, not `value !== undefined`, so a present-but-`undefined` value no longer trips it).
- **Name present (even `null`/`undefined`) → use the value, normalizing `undefined → null`.** An explicitly-supplied nothing is a value (`where x = null` — a fail-closed filter), and `null` keeps the resolved condition clean serializable JSON. `resolveBindings`/`resolveLensBindings` still leave **absent** keys as tokens (partial resolution unchanged).
- **`toPrisma` / `toSql` reject a surviving `{ bind }` token** with an explicit "resolve bindings before compiling" error, instead of silently emitting `value: undefined`.

## 2.11.0 — context bindings

Context bindings: runtime-bound values in rules and narrowings (`{ bind }`), so a `where`/value can reference tenant context (e.g. the current brand) instead of a baked literal or a non-serializable closure. A bind **preprocesses into the lens** — resolve into the chain's `where`/`sources` first, then `applyLens`/`toPrisma`/`toSql`/`sourceQueries`/`projectByPath` consume a concrete lens **unchanged**, so the whole feature is additive. Full scope + design: `tickets/FEAT-004`.

**Condition-level:**

- **`{ bind }` value source** — a third arm of `ValueSource` (`{ value } | { path } | { bind }`), valid in any value position. Resolved from a `bindings` map at execution; a referenced-but-missing bind throws.
- **`check(rule, data, { bindings })`** resolves binds during evaluation.
- **`requiredBindings(condition)`** → the `Set<string>` of bind names a condition needs.
- **`resolveBindings(condition, bindings)`** → partial / progressive: substitutes covered binds, leaves uncovered ones as tokens.

**Lens-level (preprocess into the lens):**

- **`resolveLensBindings(lensOrNarrowing, bindings)`** — resolve binds across the chain's `where`/`sources` (relations + mapDefaults), returning a new concrete lens. Partial-safe, non-mutating.
- **`lensRequiredBindings(lensOrNarrowing)`** → `Set<string>` of names the lens needs; `parent:` refs collapse to base names. Pass `narrowing.parent` to see the names a child must not collide with.
- **`validateBindNames(narrowing)`** (run by `validateNarrowing`) — bind names are unique across a chain; a re-declared name **errors**. Reference an inherited binding read-only as **`parent:name`**.

**Out of scope:** `seal` dropped (the server is the sole executor — no off-server handoff to seal); serialization-by-ref is its own follow-up (INFRA-016) and the binding path doesn't need it.

## 2.8.0

Builder-surface primitives on the lens: a leak-safe exposed surface and a rule
source/target classifier.

### `exposedSurface(lensOrNarrowing) → Lens`

The total exposed surface of a (possibly narrowed) lens, **as a Lens** (maps
intact — the navigable graph), not a projection. Every model reachable from the
anchor through visible relation/bridge edges, with the full narrowing applied —
root at the anchor, path-specific along declared relation paths, `mapDefaults`
everywhere else — unioned per model. A field appears iff it is visible on at
least one reachable, narrowed path; fields hidden on every path (including those
hidden only by `root`) are absent, so it never exposes the raw, un-narrowed lens.
`where` is dropped, the enum registry carries only exposed values, and bridges
that touch an unexposed surface (no surviving bridge-field) are eliminated.
Cycle-safe, so recursive schemas (`User → Org → members(User) → …`) terminate.

This is the **server→client** builder surface. (A `where`-preserving collapse for
a server→subtenant handoff — `seal` — is planned separately.) Contrast with
`projectByPath`, which returns a path-keyed *view* (graph flattened).

### `describeRule(rule, lensOrNarrowing) → RuleDescription`

Static classification of a rule against a lens:

```ts
{
  sources: string[],          // map (source) names the rule's fields touch
  bridgesCrossed: boolean,    // any path crosses a bridge into another source
  supportedTargets: RuleTarget[], // check / toPrisma / toSql that can run it
  violations: string[],       // field paths that don't resolve through the lens
}
```

A bridge-crossing rule is `check()`-only (`toPrisma`/`toSql` can't join across
sources — hydrate foreign rows with `buildBridgeDictionary` and evaluate in
memory). `supportedTargets` intersects per-operator catalog support with bridge
and windowing restrictions (`toSql` never compiles a window; `toPrisma` only the
extremal array rewrite). For the full security gate use `checkRuleAgainstLens`.

## 2.7.0

Two additions: a **pre-window filter** stage on windowed rules, and **catalog
reflection** coverage for the 2.6 date/window primitives.

### Pre-window `filter`

Windowing now runs **filter → order → skip → take** before the predicate, so a
rule can scope *which rows enter the window* independently of the predicate it
tests. `filter` is a `Condition` on `WindowFields` (array and aggregate rules).

```ts
// "Of the user's COMPLETED missions, the most recent one was > 30 days ago."
{
  field: 'fanMissions',
  filter: { field: 'status', operator: 'equals', value: 'completed' },
  orderBy: [{ field: 'completedAt', dir: 'desc' }],
  take: 1,
  arrayOperator: 'all',
  condition: { field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } },
}
```

Without the filter, `take: 1` would select the latest mission of *any* status.
The filter is evaluated by `check` per element (full support). Compilation is
**check-only for now**: `extremalRewrite` bails when a `filter` is present, so
`toPrisma`/`toSql` throw the "evaluate with check()" error rather than miscompile
a filtered window. Compiling a filtered window to a filtered `every`/`some` is a
candidate for a later release.

### Catalog reflection for 2.6 operators

The builder-facing operator catalog now reflects the 2.6 date/window features it
was missing:

- New `ValueShape` **`dateWindow`** for `within` — distinct from `dateRange`.
  Previously `within` reported `dateRange` (a two-endpoint literal pair), which
  contradicted the validator (it requires a single period/rolling expression).
- **`acceptsExpr`** flag on date catalog entries — marks operators that accept
  structured date expressions (`{ ago: { days: 30 } }`, `{ this: 'month' }`, …)
  in addition to / instead of literal dates. True for all date operators except
  `dayIn`/`dayNotIn`.
- **`WINDOW_SELECTOR`** + `getWindowSupport(ruleType, target)` + `WindowSupport`
  — reflect the windowing fields and per-(ruleType × target) support: `check`
  full; `toPrisma` extremal for array, none for aggregate; `toSql` none.

A new `test/operatorCatalog.integrity.test.ts` enforces that every operator in
the `Operator`/`DateOperator`/`ArrayOperator` enums has a catalog entry (and no
extras), every date operator declares an explicit `acceptsExpr`, and the window
support matrix covers every rule-type × target — so future operator additions
can't silently skip the reflection.

## 2.6.0

Two additive primitives: relative/calendar **date expressions** and an ordered
**windowing** selector.

### Date expressions + `within` operator

`DateRule.value` now accepts structured, serializable date expressions. Positive
magnitudes only — direction lives in the keyword. Units are dayjs words
(`day`/`week`/`isoWeek`/`month`/`quarter`/`year`/`hour`/`minute`/`second`).

- **Point** (with `before`/`after`/`onOrBefore`/`onOrAfter`, or `between` endpoints):
  `{ ago: { days: 30 } }`, `{ ahead: { months: 2 } }`, `{ start: <period> }`, `{ end: <period> }`
- **Range** (with the new **`within`** operator): `{ this: 'month' }`, `{ last: 'week' }`,
  `{ next: 'quarter' }`, and rolling windows `{ ago: {…} }` / `{ ahead: {…} }`
- Bare period + `before`/`after` ⇒ implied edge (`before`→start, `after`→end).

```ts
// "more than 30 days ago"
{ field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } }
// "this month"
{ field: 'completedAt', dateOperator: 'within', value: { this: 'month' } }
```

`now` is an explicit evaluator input (no implicit `Date.now()`); `check`/`toPrisma`/`toSql`
throw when a relative/period expression is used without it. `timeZone` (default
`'UTC'`) and `weekStart` (default `'monday'` → isoWeek) are per-call options on the
existing options bags. Compilers resolve expressions to concrete `Date` bounds at
compile time, so all three targets compare the same instant.

### Windowing selector (`orderBy` / `take` / `skip`)

Array and aggregate rules accept an ordered-window selector that runs before the
predicate (pipeline: order → skip → take):

```ts
// "user whose last fanMission was more than 30 days ago"
{
  field: 'fanMissions',
  orderBy: [{ field: 'completedAt', dir: 'desc' }],
  take: 1,
  arrayOperator: 'all',
  condition: { field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } },
}
```

Empty-window semantics are author-driven (`all` is vacuously true; `atLeast: 1`
requires existence). `toPrisma` compiles the **extremal** case (`take: 1`, single
`orderBy`, monotonic condition on that field, aligned direction) by rewriting to
`every`/`some` — e.g. the rule above → `{ fanMissions: { every: { completedAt: { lt:
<now-30d> } } } }`. Other windowed rules (`take > 1`, `skip`, multi-key order,
non-monotonic/misaligned conditions) and all `toSql` windowing throw a clear
"unsupported; evaluate with check()" error rather than miscompile.

## 2.5.0

**Breaking:** `projectNarrowing` removed. `projectByPath` is the projection primitive.

The flat `FieldMapSet` shape `projectNarrowing` returned was structurally lossy — it couldn't represent "User looks different at `Post.author` vs `Post.editor`" when two sibling relation paths targeted the same model. Every attempt to pick a sibling-collapse semantic was wrong-by-shape: 2.2 chose intersection (silent ∅), 2.3 chose union (silently leaked sibling-only fields — a security regression for consumers using projection as an access whitelist), 2.4 reverted to intersection and added `projectByPath` alongside. 2.5 commits to path-keyed as the only projection primitive.

### Migration

```ts
// Before (≤ 2.4)
import { projectNarrowing } from '@inixiative/json-rules';
const projected = projectNarrowing(narrowing);
projected.maps.prisma.models.User.fields.email;        // model-keyed
projected.maps.prisma.enums?.UserRole;                  // separate registry
projected.bridges;                                      // pruned bridges array

// After (3.0)
import { projectByPath } from '@inixiative/json-rules';
const projection = projectByPath(narrowing);
projection.get('User')?.fields.email;                   // path-keyed (lens anchor here)
projection.get('User')?.fields.role?.values;            // enum values inlined per field per visit
// no separate `bridges` field — the bridge-key field's presence at each visit is the truth
```

Each key in `PathProjection` is the dotted path from the lens anchor (e.g. `"User"`, `"User.posts"`, `"User.posts.author"`). Composition at each visit: path-specific picks/omits/enumPicks/enumOmits (chain-intersected) ∩ `mapDefaults[X].models[Y]` for the target model (chain-intersected) ∩ `mapDefaults[X].enums` registry narrowing. Sibling paths to the same model stay independent — no leakage.

### What this fixes

- Sibling collapse on shared targets — `Post.author: { picks: ['name'] }` and `Post.editor: { picks: ['id'] }` now correctly project two independent visits, not a collapsed single User entry.
- Per-path enum divergence — `User.role` picks `['admin']` at root and `['member']` via `posts.author` projects two visits with distinct allowed values.
- Per-path `where` clauses — each visit carries the `where` clauses anchored at that path.

### Notes

- `resolveVisit`, `checkRuleAgainstLens`, `applyLens` were already path-correct via `relPath` descent. Unchanged.
- `validateNarrowing` unchanged.
- The pre-2.5 bridge-pruning logic (drop the `bridges[]` array entry when its key field was narrowed away) doesn't have a direct equivalent — `projectByPath` doesn't return a bridges array. The bridge-key field's presence at each visit is the truth; consumers walking the projection see what's reachable.
- See [docs/LENS.md §10](./docs/LENS.md) for the full API.

## 2.4.0

`projectByPath` — path-keyed lens projection. Also reverts 2.3.0's `projectNarrowing` sibling semantics back to 2.2's intersection.

### Why

`projectNarrowing` returns a flat `FieldMapSet` keyed by `(map, model)`. That shape cannot represent "User looks different at `sourceUser` vs `targetUser`" — when two sibling relation paths target the same model, the model-keyed output forces a single answer. 2.2 made that answer intersection (silently empty); 2.3 made it union (silently leaks sibling-only fields across paths). Both are wrong-shape for per-path consumers (validation whitelists, SDK schema generation, search-field enumeration). Neither was a real fix.

### `projectByPath(lensOrNarrowing) → Map<dottedPath, ProjectedVisit>`

Path-keyed and lossless. Each `dottedPath` (e.g. `"Inquiry"`, `"Inquiry.sourceUser"`, `"Inquiry.targetUser"`) gets its own `ProjectedVisit`:

```ts
type ProjectedVisit = {
  mapName: string;
  modelName: string;
  fields: Record<string, FieldMapEntry>;  // narrowed at THIS visit (enum values inlined)
  whereClauses: Condition[];              // collected at THIS visit
};
```

Composition at each visit: path-specific picks/omits/enumPicks/enumOmits (chain-intersected) ∩ `mapDefaults[X].models[Y]` for the target model (chain-intersected) ∩ `mapDefaults[X].enums` registry narrowing. Implemented on top of `resolveVisit` (which has been path-correct since 2.1).

```ts
import { projectByPath } from '@inixiative/json-rules';

const projection = projectByPath({
  parent: postLens,
  root: {
    relations: {
      author: { picks: ['name'] },
      editor: { picks: ['id'] },
    },
  },
});

projection.get('Post.author')!.fields;   // { name: ... }              — no editor.id leak
projection.get('Post.editor')!.fields;   // { id: ... }                — no author.name leak
```

For consumers needing to enumerate searchable / validatable paths through a lens, walk the projection:

```ts
const paths: string[] = [];
for (const [dottedPath, visit] of projection) {
  for (const [field, entry] of Object.entries(visit.fields)) {
    if (entry.kind === 'scalar' || entry.kind === 'enum') {
      paths.push(`${dottedPath}.${field}`);
    }
  }
}
```

### `projectNarrowing` reverted to 2.2 intersection

2.3's sibling-union behavior is removed. When two sibling paths target the same model, the model-keyed projection again intersects their picks (conservative — fails closed, never surfaces a path that wasn't declared at every reaching path). This is still lossy for per-path questions; consumers wanting per-path accuracy should use `projectByPath`. `projectNarrowing` remains useful as a "type surface (lowest common denominator)" view.

### Migration

- If you used `projectNarrowing` and depended on 2.3's union of sibling paths (rare — the union behavior was permissive in a way that would surprise most callers), switch to `projectByPath` and walk per-path.
- If you used `projectNarrowing` in 2.2 style (single-relation lenses, mapDefaults), no change needed — same behavior restored.
- New code that enumerates paths through a lens (validation, SDK schema, search): use `projectByPath`.

## 2.3.0

Bug fix in `projectNarrowing`: sibling relation paths pointing at the same model no longer collapse via intersection.

### What was wrong

`projectNarrowing` keyed its per-model accumulator by `${mapName}::${modelName}`. Two sibling relations to the same target (e.g. `Post.author` and `Post.editor`, both `→ User`) wrote to the same `prisma::User` accumulator, intersecting their `picks` and often producing an empty field set.

Per-visit resolution (`resolveVisit`, used by `checkRuleAgainstLens` and `applyLens`) was already path-correct — it descends `narrowing.root` via the visit's `relPath`, so per-visit semantics weren't affected. The bug was contained to the flat-projection output.

### What changed

- Path-specific narrowings now accumulate per `${mapName}::${dottedPath}` (each sibling path gets its own key). Chain composition WITHIN a path still intersects (monotonic restriction is unchanged).
- The projected `FieldMapSet` is still flat (model-keyed). To collapse sibling paths down to one model entry, the projection takes the **union** across sibling paths: a field is visible in the projection iff it's visible at *some* path that reaches the model.
- `mapDefaults[X].models[Y]` still applies everywhere `Y` is reached in map `X` and intersects with the path union — applies-everywhere narrowing still bites in the projection.

### Example

```ts
// Post.author -> User, Post.editor -> User (multiRelMap)
const n: LensNarrowing = {
  parent: postLens,
  root: {
    relations: {
      author: { picks: ['name'] },
      editor: { picks: ['id'] },
    },
  },
};
const out = projectNarrowing(n);
// 2.3: out.maps.prisma.models.User has BOTH name AND id (union across sibling paths)
// pre-2.3 bug:  prisma::User acc intersected ['name'] ∩ ['id'] = {} — User vanished
```

For path-specific views into a descended model (where the AI/builder needs to know "at *this* path, only X is visible"), use `resolveVisit(policy, mapName, modelName, relPath)` directly — that's been path-correct since 2.1.

## 2.2.0

Structural cleanup of `LensNarrowing`. The path-specific anchor and per-map applies-everywhere defaults now live as separate top-level fields — `root` and `mapDefaults` — replacing the dual-purpose `maps` dictionary and the root-level `where` outlier. Composition semantics are unchanged.

### The shape

```ts
type LensNarrowing = {
  parent: Lens | LensNarrowing;
  root?: ModelNarrowing;                         // path-specific, anchored at (lens.mapName, lens.model)
  mapDefaults?: Record<string, NarrowingDefaults>; // per-map applies-everywhere
};
```

`root` descends via `.relations` (across maps via bridges). `mapDefaults[X].models[Y]` and `mapDefaults[X].enums[E]` apply wherever Y / E is reached in map X.

### Example

```ts
// Path-specific scope at the lens anchor + everywhere-soft-delete on Comment
const narrowing: LensNarrowing = {
  parent: lens,
  root: {
    where: { field: 'tenantId', operator: Operator.equals, path: 'tenantId' },
    relations: {
      posts: { picks: ['id', 'title', 'comments'] },
    },
  },
  mapDefaults: {
    prisma: {
      models: {
        Comment: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
      },
      enums: {
        UserRole: { omits: ['guest'] },
      },
    },
  },
};
```

The three `where` anchor layers now read as:

- `root.where` — root visit of the lens anchor
- `mapDefaults[X].models[Y].where` — wherever Y appears in map X
- `root.relations[R]...where` — only when the rule descends through R

### Strictness expansion: enum validation

`validateNarrowing` now applies the same monotonic-restriction check to enum narrowing that 2.1 already applied to picks/omits. Per-field `enumPicks/enumOmits` are checked against same-layer + ancestor `mapDefaults[X].enums[type]`, same-layer + ancestor `mapDefaults[X].models[Y].enumPicks/enumOmits[field]`, and ancestor's same-position narrowings. Narrowings that previously silently composed to a tighter set than declared now throw at construction.

### Internal cleanup that came with it

`validatePathNarrowing` now derives per-visit defaults from the chain on each hop — cross-map / cross-model descent picks up the right `mapDefaults[targetMap].models[targetModel]` per visit, fixing a pre-existing bug where the lens anchor's defaults were applied at every descended model. The "lens-level where: anchored to root" special case in `policy.ts` is gone; root wheres now flow through the same per-visit accumulator as everything else.

## 2.1.0

Major lens v2.1: schema-narrowing + data-narrowing as first-class primitives, with composition that respects anchoring instead of blindly AND-ing at root.

**Why this matters:** v2.1 turns the lens into a real containment layer for less-trusted callers — LLM agents, customer-facing UIs, third-party integrations. Schema narrowing (`picks` / `omits` / `enumPicks` / `enumOmits`) makes restricted fields *invisible*; the rule author literally can't reference them. Data narrowing (`where`) anchors row-scope constraints to the model they describe, so a `Comment.deletedAt IS NULL` scope travels into the comment subtree of a user's rule instead of being blindly AND'd at the root. Composition across the chain is pure intersection — no narrowing can re-add what a parent removed. Hand a caller a narrowed lens, let them author whatever rule they like, and the lens enforces the boundary at compile time.

### Breaking (type-level)

- **`FieldMap` shape changed** from `Record<string, ModelEntry>` to `{ models: Record<string, ModelEntry>; enums?: Record<string, readonly string[]> }`. Every consumer of `FieldMap` needs to access models via `map.models[X]` instead of `map[X]`. Required to give each FieldMap its own enum registry (avoids cross-source enum namespace collision) and to keep room for future schema-level additions.
- **`LensNarrowing.constrains` renamed to `LensNarrowing.where`.** Same shape, name change. The renaming reflects the filter-first semantic explicitly — the field is a SQL-like `where` clause that scopes which rows are in scope, not a generic constraint. Migration: `find/replace constrains → where` in narrowing declarations.

### Lens narrowing v2.1

Two distinct kinds of narrowing now live in `MapNarrowing`:

- **Schema narrowing** (controls what's visible in the type surface): `picks`, `omits`, `enumPicks`, `enumOmits`. SDK/AI cannot reference narrowed-away fields or enum values.
- **Data narrowing** (controls which rows are in scope): `where`. Filter-first semantic — anchored to the model it describes, NOT blindly AND'd at root.

New shape:

```ts
type FieldMap = {
  models: Record<string, ModelEntry>;
  enums?: Record<string, readonly string[]>;
};

type ModelDefaultNarrowing = {
  picks?, omits?, enumPicks?, enumOmits?,
  where?: Condition;   // no `relations` — relations are path-specific
};

type ModelNarrowing = ModelDefaultNarrowing & {
  relations?: Record<string, ModelNarrowing>;
};

type EnumNarrowing = { picks?, omits? };

type MapNarrowing = {
  models: Record<string, ModelNarrowing>;     // path-specific
  defaults?: {                                 // applies-everywhere
    models?: Record<string, ModelDefaultNarrowing>;
    enums?: Record<string, EnumNarrowing>;
  };
};
```

Composition: pure intersection across all layers. Each chained narrowing further restricts the surface.

### Center-of-gravity: `src/lens/policy.ts`

New internal `resolvePolicy(lensOrNarrowing)` + `resolveVisit(policy, mapName, modelName, relPath)` resolver. Single source of truth for "what's visible / what's allowed / what wheres apply" at any model visit. `checkRuleAgainstLens`, `applyLens`, and `validateNarrowing` all use it instead of reimplementing composition.

### Anchored `where` composition (`applyLens` rewrite)

`applyLens` is now AST-aware. Walks the user rule and injects `where` clauses at the correct anchor point in the rule tree:

- Root-level wheres (`LensNarrowing.where`, `models[rootModel].where`, `defaults.models[rootModel].where`) — AND at root.
- `defaults.models[M].where` — injected wherever the rule visits model M.
- `relations[R].where` — injected when the rule descends into relation R.

Operator-specific injection inside an `arrayRule.condition`:

- `any` / `none` / `atLeast` / `atMost` / `exactly` / `aggregate.condition`: AND injection (`{ all: [where, original] }`).
- **`all`**: filter-first via implication (`{ any: [negate(where), original] }`) so the user's "every row matches" semantic operates on the filtered set rather than rejecting out-of-scope rows. New internal `negate()` helper handles inversion using existing negative operators (`notEquals`, `notIn`, `none`, etc. + De Morgan for compound conditions). Throws clearly on `startsWith` / `endsWith` / `exactly` (no inverse in DSL).

### Path-aware `checkRuleAgainstLens`

Walks the narrowing tree per-path alongside the user rule, instead of validating against a flat projected set. Same model reached via different paths (e.g. `User.manager` vs `User.posts.author`) honors per-path narrowings independently.

### Enum value validation

`checkRuleAgainstLens` rejects rule values not in the resolved enum set, considering `FieldMap.enums` (registry) ∩ `FieldMapEntry.values` ∩ `defaults.enums[T]` ∩ `enumPicks/enumOmits[field]`. Covers leaf rules and nested rules inside `all`/`any`/`if`/`arrayRule.condition`.

### Strict `validateNarrowing`

Each narrowing layer can only mention fields/enum values still visible from layers above and the same layer's defaults. Picks/omits/enumPicks/enumOmits referencing already-excluded items throw clearly at construction. `relations` declared on a `ModelDefaultNarrowing` throws (runtime safety net for type-bypass). `where` clauses validate against the model they anchor to.

### `projectNarrowing` composition fix

The pre-2.1 last-write-wins bug (multiple narrowings of the same model with overlapping picks would erase prior fields) is fixed. Composition is intersection across all layers — each layer further restricts.

### Source hygiene test

New `test/sourceHygiene.test.ts` rejects invisible control characters (NUL, etc.) in source files — caught one such byte that was hiding in the v2.1 work before commit.

### Tests added (130+)

- `v2_1.composition.test.ts`, `v2_1.defaults.test.ts`, `v2_1.enumNarrowing.test.ts` — schema narrowing + defaults composition
- `v2_1.validateNarrowing.test.ts` — strict inheritance rules
- `v2_1.pathAware.test.ts` — same-model-different-path narrowing
- `v2_1.anchoredConstrains.test.ts` — per-operator anchored where injection
- `v2_1.enumValueValidation.test.ts` — rule value enum membership
- `v2_1.deepPathLockdown.test.ts` — narrowed-away paths rejected
- `v2_1.arrayOpNarrowingSemantics.test.ts` — end-to-end array operator semantics with real data

667 total tests pass, typecheck + lint clean.

## 2.0.3

Hardening note from external review: the `conditionTouchesBridge` guard added in 2.0.1/2.0.2 stopped at outer field paths and did not recurse into `arrayRule.condition` or `aggregate.condition`. A bridge field hidden inside `some`/`every`/`none`/`aggregate` sub-conditions, under an `if`/`then`/`else`, still corrupted the implication semantics — silently dropping branches.

### Fixes

- **`toPrisma` and `toSql` `conditionTouchesBridge` walkers** now recurse into the nested `condition` of `arrayRule` and `aggregate` rules, flipping the model context to the relation target (via a new `resolveRelationTargetModel` helper). A bridge anywhere in the if-clause subtree — at any depth — now triggers the over-fetch (`{}` / `'TRUE'`).

### Tests added (5)

- `test/bridgeIfThen.nestedSubCondition.test.ts` — bridge inside `if`/`then` `arrayRule.condition`, bridge buried two levels deep inside an `all` inside `arrayRule.condition`, toSql guard-catches-before-throw case.

## 2.0.2

Second hardening pass — fixes the round-3 review findings: ESM consumers were broken in 2.0.0/2.0.1, plus three more silent miscompiles symmetric to (or missed by) the 2.0.1 fixes.

### Fixes

- **ESM build broken for Node consumers** — `dist/index.js` emitted `import { get, ... } from 'lodash'`, which fails at runtime because lodash is CJS-only and provides no named ESM exports. Switched all source imports from `lodash` to `lodash-es` and bundled it (dropped from tsup `external`) so both ESM and CJS artifacts are self-contained. CJS consumers no longer get an `ExperimentalWarning` from require()-ing an ES Module.
- **`toSql` bridge if/then under-fetch** — mirror of the 2.0.1 toPrisma fix; bridge predicates compile to `'TRUE'`, then `NOT(TRUE) OR then` collapses to `then`, silently dropping branches in the `else` variant. `toSql/logical.ts` now applies the same `conditionTouchesBridge` guard across `if` / `then` / `else` and emits `'TRUE'` (over-fetch) when any sub-clause hits a bridge.
- **`else: false` was silently skipped** — `condition.else` truthiness checks in `check.ts`, `toPrisma/logical.ts`, and `toSql/logical.ts` meant `else: false` (a legal deny-branch condition) was treated as no-else. Now use `!== undefined`. `toPrisma` also handles `then: false` / `else: false` by emitting the same match-nothing pattern that `buildAny` uses for empty arrays (instead of letting `buildCondition(false)` throw).
- **`toPrisma` `some`/`every`/`none` used parent model for inner conditions** — `buildArrayLeafFilter` passed `options` unchanged into the inner `buildCondition`, so JSON-path and bridge detection misfired against the parent model rather than the relation target. Now resolves the relation target via `resolveRelationTarget` and threads `{ ...options, model: targetModel }` into inner calls.

### Dependency changes

- `lodash` removed from runtime dependencies.
- `lodash-es` added as a devDependency (bundled, not a runtime dep).
- `@types/lodash` → `@types/lodash-es`.

### Tests added (12)

- `test/toSql.bridgeIfThen.test.ts` (5)
- `test/elseFalse.test.ts` (4)
- `test/toPrisma.relationModelContext.test.ts` (3)

ESM/CJS smoke tests via `node` verify both artifacts import cleanly.

## 2.0.1

Hardening release surfaced by two adversarial review rounds. No API changes; all fixes are bug fixes or new loud-failure paths replacing prior silent miscompiles.

### Fixes

- **`toPrisma` if/then/else with bridge sub-clauses** — when any of `if`/`then`/`else` referenced a bridge field, the implication encoding `NOT(if) OR then` collapsed in Prisma (because `NOT: {}` is match-nothing), silently dropping the `then` or `else` branch and producing wrong query plans. `buildIfThenElse` now detects bridge-tainted sub-clauses via `conditionTouchesBridge` and short-circuits to `{}` (over-fetch), letting the caller's `check()` filter precisely.
- **`toPrisma` `FieldMapSet` without `mapName`** — `normalizeOptions` silently passed a `FieldMapSet` through as if it were a `FieldMap`, producing queries lacking JSON-path detection and bridge handling. Now throws `toPrisma: 'map' is a FieldMapSet — 'mapName' is required`.
- **`buildBridgeDictionary` reversed-endpoint silent dedup** — the convention is endpoint[0] = "one" side, endpoint[1] = "many" side; reversed bridges produced wrong `isList` flags in stitching AND silently deduped rows via `keyBy`. Added `keyByUnique` helper that throws on duplicate `on` values with a fix hint; documented the convention on `Bridge` via JSDoc.
- **`buildBridgeDictionary` null FK values** — many-side rows with `null`/`undefined` `on` values were grouped under string keys `'null'`/`'undefined'` by lodash `groupBy`, creating spurious joins. Now filtered before grouping.
- **`check()` `arrayOperator` over primitive arrays** — `all`/`any`/`none`/`atLeast`/`atMost`/`exactly` over a primitive-only array threw, breaking the `boolean | string` contract and allowing a rule-driven crash of the caller process. Now returns a descriptive error string (respects `condition.error` override).

### Tests added (19)

- `test/toPrisma.bridgeIfThen.test.ts` (5)
- `test/toPrisma.fieldMapSet.test.ts` (4)
- `test/buildBridgeDictionary.reversed.test.ts` (2)
- `test/buildBridgeDictionary.nullKey.test.ts` (2)
- `test/check.primitiveArray.test.ts` (6)

## 2.0.0

First version of the **Lens** primitive — schema-aware view layer with cross-source bridges and recursive narrowings. New compile-time boundary semantics in `toPrisma` and `toSql`. Operator catalog as canonical source of operator/target/kind/value-shape facts. `pg` removed from runtime dependencies.

### Breaking (type-level)

- `FieldMapEntry.kind` widened from `'scalar' | 'object' | 'enum'` to include `'bridge'`. Exhaustive `switch (kind)` consumers without a `default` will fail TS narrowing — handle the new kind or default to ignore.
- `BuildOptions.map` widened from `FieldMap` to `FieldMap | FieldMapSet`. Code that passed `options.map` straight to functions typed as `FieldMap` will need a cast or normalization (or use the new `mapName` field, which triggers automatic resolution at the toPrisma entry).
- `FieldMapSet` restructured from `Record<string, FieldMap>` to `{ maps: Record<string, FieldMap>; bridges?: Bridge[] }`. Bridges live declaratively on the set instead of being a separate argument.
- `stitchFieldMaps` signature changed from `(set, bridges)` to `(set)` — bridges are read from `set.bridges`.
- `BridgeEndpoint` now requires `on: string` — the field on this endpoint that participates in the join.
- `RuleValidationTarget` removed; `RuleTarget` (from `operatorCatalog`) takes its place. Same string union.
- `check(rule, data)` third arg is now an options bag `{ context? }` instead of a raw context value.

No runtime behavior changes for callers not using the new primitives.

### Lens primitive

- **`Lens`** — `FieldMapSet & { mapName: string; model: string }`. Pure schema; no runtime data. Single sanctioned construction path is `createLens({ maps, bridges?, mapName, model })` which stitches bridges internally.
- **`FieldMapSet`** — `{ maps, bridges? }` declarative shape; multi-source schemas express cross-source edges inline.
- **`Bridge`** — bi-directional edge between two `(fieldMap, model, on)` endpoints with `cardinality: 'oneToOne' | 'oneToMany'`. Stitched as `kind: 'bridge'` pseudo-fields on each endpoint model.
- **`LensNarrowing`** — recursive tree: `parent` → `maps[name].models[name]` with `picks`/`omits`/`relations`. Children narrow further only. Lens-level `constrains?: Condition` ANDs into any rule evaluated against the lens.
- **`applyLens(rule, narrowing)`** — composes chain constraints with the user rule: `{ all: [...chainConstraints, rule] }`. The rule-side composer.
- **`projectNarrowing(lens)`** — produces the effective `FieldMapSet` after applying the narrowing chain. The schema-side composer.
- **`checkRuleAgainstLens(rule, lens)`** — walks rule AST, returns `{ ok, violations }` against the projected surface; context-aware (inner conditions resolve against relation target, not lens root).
- **`validateNarrowing(narrowing)`** — structural + parent-chain cascade rules; validates `constrains` paths.
- **`stitchFieldMaps(set)`** — injects bridges into a FieldMapSet's maps. Validates `on` references a real field per endpoint; rejects self-bridges.
- **`buildBridgeDictionary(set, rawData)`** — utility for callers: takes raw foreign arrays, returns dicts keyed by each endpoint's `on` field, nested map → model → on → identifier. 1-1 via `keyBy`, 1-many via `groupBy`. Supports the same model on multiple bridges with different `on` fields.

### Operator catalog (new)

- **`OPERATOR_CATALOG`** — canonical `Record<Operator | DateOperator | ArrayOperator, { kinds, targets, valueShape }>` across `FIELD_OPERATOR_CATALOG`, `DATE_OPERATOR_CATALOG`, `ARRAY_OPERATOR_CATALOG`. `validate.ts` reads exclusively from the catalog; per-operator switches in validate replaced with `getValueShape` + `isOperatorSupportedForTarget` lookups.
- **`FieldKind`** — `String | Boolean | Int | BigInt | Float | Decimal | DateTime | Json | Bytes | Enum`.
- **Kind groups** — `NUMERIC_KINDS`, `ORDERABLE_KINDS`, `STRINGY_KINDS`, `EQUATABLE_KINDS`, `ALL_KINDS`. `Json`/`Bytes` excluded from `EQUATABLE_KINDS`.
- **`ValueShape`** — `'none' | 'scalar' | 'ordered' | 'array' | 'string' | 'pattern' | 'range' | 'dateValue' | 'dateRange' | 'dayList' | 'count' | 'predicate'`. The picker-layout contract for FE consumers.
- **Helpers** — `getOperatorsForKind(kind, target?)`, `getArrayOperators(target?)`, `getValueShape(op)`, `isOperatorSupportedForTarget(op, target)`, `isAggregateSingleOperator(op)`, `isAggregateRangeOperator(op)`. All exported.

### Engine

- **`check(rule, data, options?)`** — options bag `{ context? }`. Propagates through recursive helpers (`all`/`any`/`checkArray`/`checkAggregate`/`checkIfThenElse`).
- **Root-array `check()`** — when `data` is an array, the rule must be a tree of `all`/`any` whose leaves are fieldless `ArrayRule`s. Validated upfront via `validateRootArrayShape`; `ArrayRule.field` is optional. `toPrisma`/`toSql` compilation of fieldless `ArrayRule`s is not yet implemented.
- **Bridge keys at eval time** — engine walks paths via plain `lodash.get`; foreign rows attached under `<fieldMap>:<Model>` keys on data work without any lens-aware resolution. 1-many bridges produce arrays; intermediate-index path resolution works (`'crm:Event.0.x'`), no-index intermediate returns undefined (documented).

### Compile-target changes

- `toPrisma`: emits `{}` (Prisma "match anything") for any predicate whose field path hits a bridge. No-op in AND, over-fetches in OR. Caller follows up with in-memory `check()` against hydrated cross-source data.
- `toPrisma`: normalizes `BuildOptions.map` at entry — if `mapName` is set, resolves `(map as set)[mapName]` to a single FieldMap.
- `toSql`: emits `'TRUE'` for any rule whose field path hits a bridge.

### Dependencies

- **`pg` removed entirely.** Was an optional peerDependency in 1.3.4 but the bundled artifact still imported `escapeIdentifier from 'pg'`, breaking consumers. The one-line identifier escape is now inlined in `src/toSql/escape.ts`. `@types/pg` also dropped.
- Runtime deps: `dayjs`, `lodash`. Nothing else.

### Hardening (adversarial review fixes)

- `stitchFieldMaps` validates `BridgeEndpoint.on` references a real field on the endpoint model; rejects self-bridges.
- `projectNarrowing` clones `bridges` (was aliased by reference).
- `checkRuleAgainstLens` is context-aware — paths in `arrayRule`/`aggregate` conditions resolve against the relation target.
- `validateFieldMapSet` skips bridge entries (stitched outputs no longer fail validation for containing `:`).
- `getRoot` / `collectChain` / `applyLens` detect cycles in narrowing parent chains via a visited set; throw clearly instead of looping.
- `StrictArrayRule.field` optional (matches relaxed `ArrayRule`).
- `applyLens` uses `!== undefined` check on `constrains`, so `constrains: false` (deny-all) is preserved.

## 1.3.4

- Move `pg` to optional peerDependency, fix dayjs ESM imports. **Broken**: bundle still imported `pg` at runtime. Fixed in 2.0.0.

## 1.3.3 and earlier

See git history.
