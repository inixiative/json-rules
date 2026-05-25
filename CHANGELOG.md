# Changelog

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
