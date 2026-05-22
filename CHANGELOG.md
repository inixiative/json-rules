# Changelog

## 2.0.0

First version of the **Lens** primitive — schema-aware view layer with cross-source bridges and recursive narrowings. New compile-time boundary semantics in `toPrisma` and `toSql`. Operator catalog as canonical source of operator/target/kind/value-shape facts. `pg` removed from runtime dependencies.

### Breaking (type-level)

- `FieldMapEntry.kind` widened from `'scalar' | 'object' | 'enum'` to include `'bridge'`. Exhaustive `switch (kind)` consumers without a `default` will fail TS narrowing — handle the new kind or default to ignore.
- `BuildOptions.map` widened from `FieldMap` to `FieldMap | FieldMapSet`. Code that passed `options.map` straight to functions typed as `FieldMap` will need a cast or normalization (or use the new `mapName` field, which triggers automatic resolution at the toPrisma entry).
- `FieldMapSet` restructured from `Record<string, FieldMap>` to `{ maps: Record<string, FieldMap>; bridges?: Bridge[] }`. Bridges live declaratively on the set instead of being a separate argument.
- `stitchFieldMaps` signature changed from `(set, bridges)` to `(set)` — bridges are read from `set.bridges`.
- `BridgeEndpoint` now requires `on: string` — the field on this endpoint that participates in the join.
- `RuleValidationTarget` removed; `RuleTarget` (from `operatorCatalog`) takes its place. Same string union.
- `check(rule, data)` third arg is now an options bag `{ context?, lens?, sources? }` instead of a raw context value.

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
- **`buildBridgeIndex(set, rawData)`** — utility for callers: takes raw foreign arrays, returns dicts keyed by each endpoint's `on` field, nested map → model → on → identifier. 1-1 via `keyBy`, 1-many via `groupBy`. Supports the same model on multiple bridges with different `on` fields.

### Operator catalog (new)

- **`OPERATOR_CATALOG`** — canonical `Record<Operator | DateOperator | ArrayOperator, { kinds, targets, valueShape }>` across `FIELD_OPERATOR_CATALOG`, `DATE_OPERATOR_CATALOG`, `ARRAY_OPERATOR_CATALOG`. `validate.ts` reads exclusively from the catalog; per-operator switches in validate replaced with `getValueShape` + `isOperatorSupportedForTarget` lookups.
- **`FieldKind`** — `String | Boolean | Int | BigInt | Float | Decimal | DateTime | Json | Bytes | Enum`.
- **Kind groups** — `NUMERIC_KINDS`, `ORDERABLE_KINDS`, `STRINGY_KINDS`, `EQUATABLE_KINDS`, `ALL_KINDS`. `Json`/`Bytes` excluded from `EQUATABLE_KINDS`.
- **`ValueShape`** — `'none' | 'scalar' | 'ordered' | 'array' | 'string' | 'pattern' | 'range' | 'dateValue' | 'dateRange' | 'dayList' | 'count' | 'predicate'`. The picker-layout contract for FE consumers.
- **Helpers** — `getOperatorsForKind(kind, target?)`, `getArrayOperators(target?)`, `getValueShape(op)`, `isOperatorSupportedForTarget(op, target)`, `isAggregateSingleOperator(op)`, `isAggregateRangeOperator(op)`. All exported.

### Engine

- **`check(rule, data, options?)`** — options bag `{ context?, lens?, sources? }`. Propagates through recursive helpers (`all`/`any`/`checkArray`/`checkAggregate`/`checkIfThenElse`). Today the engine consumes `context` only; `lens`/`sources` are plumbed for future lens-aware bridge resolution.
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
