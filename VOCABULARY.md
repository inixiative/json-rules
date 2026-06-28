# Vocabulary

The inixiative ecosystem is built "solve it once": each concern has **one canonical home**, and new features resolve *to* it rather than around it. This page is the glossary of those primitives — what each one **solves** and **how it works** — grouped from the atom outward.

The layers:

```
rule logic ─▶ schema ─▶ lens (scoped view) ─▶ sources ─▶ check / compile
                                  │
                                  ▼
                         builders (headless UI)
                                  │
                                  ▼
                    transitions · permissions  (downstream)
```

---

## 1 · Rule logic — the atom

### `Condition`
**Solves:** one serializable way to express "does this hold?" — the single predicate language used everywhere a yes/no over data is needed.
**How:** a recursive JSON tree — `all`/`any` (boolean), field operators (`equals`, `in`, `contains`, `between`…), array operators (`any`/`all`/`none`/`atLeast`…), date operators, aggregates, and `if`/`then`/`else`. No code, no `eval` — pure data you can store, ship, and diff.

### `check(condition, data, options?)`
**Solves:** evaluate a `Condition` against a record — the authoritative runtime answer.
**How:** walks the tree against `data`, returning `true` or a human-readable failure string. Handles everything the compile targets can't (array predicates, aggregates, windowing). This is the "fetch results, then filter through the rules" backstop.

### `Operator` · `ArrayOperator` · `DateOperator` · `ValueShape`
**Solves:** a closed, introspectable catalog of what comparisons exist and what input each needs.
**How:** enums of operators plus `getValueShape(op)` → `scalar | range | array | dateWindow | predicate | none`. A UI uses the shape to decide which input to render; the catalog is the same one `check` and the compilers honor.

### `RuleTarget`
**Solves:** "where will this rule run?" — `check` (in-memory), `toPrisma`, `toSql` — so a rule can be restricted to operators all chosen targets support.
**How:** a tag; operator availability is intersected across the selected targets.

---

## 2 · Schema — the shape of data

### `FieldMap` / `FieldMapEntry`
**Solves:** describe data (models, fields, kinds, relations, allowed values) without coupling to any ORM.
**How:** `{ models: { Model: { fields: { name: FieldMapEntry } } }, enums? }`. An entry has `kind` (`scalar | object | enum | bridge`), `type`, optional `isList`, `fromFields`/`toFields` (FK columns), and `values`.

### `FieldMapEntry.values`
**Solves:** "constrained value set" solved once — enums, picklists, and hydrated sources all route through it.
**How:** an optional `readonly string[]` on any field. `checkRuleAgainstLens` gates rule values against it **regardless of kind** (scalar, enum, or Json) — no enum-promotion hack.

### `Bridge` · `stitchFieldMaps` · `buildBridgeDictionary`
**Solves:** navigable relations *across* separate field maps (e.g. Prisma + Salesforce + CRM) without merging them.
**How:** a `Bridge` declares two endpoints (`fieldMap:model.on`) and a cardinality; `stitchFieldMaps` injects a navigable `map:model` field on each side; `buildBridgeDictionary` materializes the cross-map links.

---

## 3 · Lens — one schema, many scoped views

A **lens** exists in three forms of the same thing — this is the central idea:

| Version | What | Used for |
|---|---|---|
| **Reference** | `Lens` / `LensNarrowing` — anchor + serializable narrowing chain | author, store, ship |
| **Full** | `resolvePolicy` + `resolveVisit` → `VisitEffect` per node | the computed view (everything, narrowing applied) |
| **Public/projected** | `exposedSurface` (per-model) · `projectByPath` (per-path) | the leak-safe surface a UI/consumer sees |

### `Lens` · `createLens`
**Solves:** anchor a view at a model in a map, with bridges available.
**How:** `createLens({ maps, bridges?, mapName, model })` → the reference lens; everything else narrows or projects from it.

### `LensNarrowing`
**Solves:** monotonically restrict a lens as it's scoped down (per tenant/role) — never widen.
**How:** a parent-linked chain. Each node carries `picks`/`omits` (field visibility), `enumPicks`/`enumOmits` (value sets), `where` (a row-filter `Condition`), `sources` (data-backed option sets), and `relations` (per-relation narrowing, recursively). Composes filter-first, AND-only.

### `resolvePolicy` / `resolveVisit`
**Solves:** compute the full effect of the narrowing chain at any model/path.
**How:** folds the chain into a `VisitEffect` — visible fields, allowed value sets (`enumValuesByField`), composed `where`, and `sources`.

### `exposedSurface(lens, { sourceValues? })`
**Solves:** the leak-safe **public** surface — a flat `Lens` of only what's visible, per model.
**How:** walks every reachable model, unions visible fields, and folds narrowed *and* fetched `values` onto `field.values`.

### `projectByPath(lens, { sourceValues? })`
**Solves:** the **per-path** projection — when the same model at different paths needs different option sets.
**How:** `Map<dottedPath, ProjectedVisit>`; folds values keyed exactly by path.

### `validateNarrowing`
**Solves:** catch a narrowing that widens (illegal) or references missing fields.
**How:** structural validation over the chain; rejects anything non-monotonic.

---

## 4 · Sources — a column's contents as an option set

### `sources` (on a narrowing model)
**Solves:** turn the live values of a column into a field's selectable options (a "pseudo-enum"), scoped by the lens.
**How:** `sources: { field: Condition }` on a model in the narrowing — a per-field eligibility `where` that composes like `where` (general via `mapDefaults`, path-specific via `root`/`relations`, AND-only).

### `sourceQueries(lens)` · `SourceValues`
**Solves:** compile the queries that materialize those option sets — *engine compiles, app executes*.
**How:** emits a `SELECT DISTINCT field WHERE <narrowing ∧ source>` per `(path, field)` as both Prisma and SQL. The app runs them and ships back `SourceValues = { path, mapName, model, field, values }`, which fold onto `field.values` inside the projection (§3). The wire format is `{ lens, sourceValues }` — both serializable.

---

## 5 · Checking & describing against a lens

### `checkRuleAgainstLens(rule, lens)`
**Solves:** "is this rule *expressible and allowed* under this lens?" — the authoring-time gate.
**How:** walks the rule against the projected lens; flags fields that aren't visible and values outside the allowed set (enum or sourced). Returns `{ ok, violations }`.

### `describeRule(rule, lens)`
**Solves:** classify a rule — which maps it touches, whether it crosses a bridge, which targets it supports.
**How:** static analysis over the rule + lens → a `RuleDescription`.

### `applyLens(rule, lens)`
**Solves:** enforce a lens's row-filters on a rule — so an evaluated/compiled rule always carries the lens's narrowing constraints.
**How:** ANDs the narrowing's `where` clauses into the rule (injecting correctly through array conditions), returning a new `Condition`.

---

## 6 · Compile targets — push the predicate to the store

### `toPrisma(condition, { map, mapName, model })`
**Solves:** run a `Condition` as a Prisma query (a prefilter, or the full filter where expressible).
**How:** emits a Prisma `where` (+ `groupBy` steps for count operators).

### `toSql(condition, { map, model, alias })`
**Solves:** the same, as parameterized SQL.
**How:** emits `{ sql, params, joins }`. Degrades gracefully on predicates SQL can't express (array-condition operators) — the app falls back to `check`.

---

## 7 · Builders — headless UI on the lens (`@inixiative/rules-builder`)

### `resolve(source, { sourceValues? })`
**Solves:** the whole assembly in one call.
**How:** createLens + narrowing + value-fold + projection → the public surface a builder reads. (The rules-builder face of `exposedSurface`.)

### `useRuleBuilder(...)` → descriptor tree
**Solves:** build/edit a `Condition` **headlessly** — logic in, descriptors out, you render.
**How:** returns `{ value: Condition, root }` where `root` is a recursive `GroupNode`/`LeafNode` tree. Each node states *what controls exist* (field/operator/value, each `{ value, options, set }`) plus bound actions (`addRule`, `remove`, …). Renders nothing — wire your own components (a copy-paste reference renderer + shadcn drop-in are provided).

### `lensValuePicker(lens, { maxDepth? })`
**Solves:** "pick any value reachable through a lens" — the shared atom behind a rule's `field` (LHS) and `path` (RHS reference), reused downstream (permissions, email).
**How:** enumerates leaf values across relations as dotted paths, with kind and allowed values.

### `describeModelFields(lens, map, model)` → `BuilderField`
**Solves:** "what can I build on this field?" — operators, value shape, options.
**How:** per-field descriptor (kind, operators by target, `enumValues`) the renderer consumes.

---

## 8 · Downstream layers

### `@inixiative/transitions`
**Solves:** declarative, serializable state-machine **guards + affordances** — "can this record move from A→B, and who may?"
**How:** a `TransitionMap` (model → action → `from`/`to`, guard `ActionRule`, optional `Merge`), evaluated through an injected `Authorize` seam. Reuses `Condition`/`check` for the predicate — it doesn't re-solve reasoning.

### `@inixiative/permissions`
**Solves:** rebac/abac/rbac in one ORM-agnostic core.
**How:** an `ActionRule` is a `RuleCheck` (a `Condition` over the record = **ABAC**), a `RelationCheck` (walk a relation, then check = **ReBAC**), or a `SelfCheck` (record field == actor id). A permix wrapper + relationship-walking engine, ORM-agnostic via an injected `ResolveModel`.

### `atlas`
**Solves:** navigate the codebase by **concept**, not folders.
**How:** `@atlas` annotations + a concept graph + `MAP.md`; query by `kind` / `partOf` / `uses`.

---

## The one-line version

`Condition` is the atom; `FieldMap` is the shape; a **lens** scopes the shape; **sources** turn data into options; `check`/`checkRuleAgainstLens` enforce; `toPrisma`/`toSql` push to the store; **builders** edit it headlessly; **transitions** and **permissions** compose it — never re-solving it.
