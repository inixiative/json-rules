# Changelog

## 2.0.0

First version of the **Lens** primitive — schema-aware view layer with cross-source bridges and recursive narrowings. New compile-time boundary semantics in `toPrisma` and `toSql`.

### Breaking (type-level)

- `FieldMapEntry.kind` widened from `'scalar' | 'object' | 'enum'` to include `'bridge'`. Exhaustive `switch (kind)` consumers without a `default` will fail TS narrowing — handle the new kind or default to ignore.
- `BuildOptions.map` widened from `FieldMap` to `FieldMap | FieldMapSet`. Code that passed `options.map` straight to functions typed as `FieldMap` will need a cast or normalization (or use the new `mapName` field, which triggers automatic resolution at the toPrisma entry).
- `FieldMapSet` restructured from `Record<string, FieldMap>` to `{ maps: Record<string, FieldMap>; bridges?: Bridge[] }`. Bridges live declaratively on the set instead of being a separate argument.
- `stitchFieldMaps` signature changed from `(set, bridges)` to `(set)` — bridges are read from `set.bridges`.
- `BridgeEndpoint` now requires `on: string` — the field on this endpoint that participates in the join. Bridges without `on` can't drive cross-source evaluation; it's the schema-level info the eval path consumes.

No runtime behavior changes for callers not using the new primitives.

### Added

- **`Lens`** — `{ map, mapName?, model, sources? }`. Destructures directly into `BuildOptions`. `sources` carries pre-fetched, scope-resolved data for the FE rule builder (e.g. brand-defined custom field definitions, mission lists). Pure data — caller resolves, library never fetches.
- **`FieldMapSet`** — `{ maps, bridges? }` declarative shape; multi-source schemas express their cross-source edges inline.
- **`Bridge`** — bi-directional edge between two `(fieldMap, model, on)` endpoints with `cardinality: 'oneToOne' | 'oneToMany'`. Stitched as `kind: 'bridge'` pseudo-fields on each endpoint model. `on` is the symmetric join field on each side; eval-path uses it for cross-source hydration.
- **`stitchFieldMaps(set)`** — injects bridges into a FieldMapSet's maps.
- **`validateFieldMap` / `validateFieldMapSet`** — forbid `.`/`:` in field names; accumulate errors.
- **`LensNarrowing`** — recursive tree: `parent` → `maps[name].models[name]` with `picks`/`omits`/`relations`. Children narrow further only. Lens-level `constrains?: Condition` ANDs into any rule evaluated against the lens.
- **`validateNarrowing(narrowing)`** — structural + parent-chain cascade rules; validates `constrains` paths via `checkRuleAgainstLens`.
- **`projectNarrowing(lens)`** — produces the effective `FieldMapSet` after applying the narrowing chain.
- **`checkRuleAgainstLens(rule, lens)`** — walks rule AST, returns `{ ok, violations }` against the projected surface.
- **`applyLens(rule, narrowing)`** — composes chain constraints with the user rule (`{ all: [...chainConstraints, rule] }`).
- **`getSources(lens)`** — returns the root lens's `sources` (or `{}`); sources live on Lens, not on narrowings.
- **`buildBridgeIndex(bridges, rawData)`** — utility for callers: takes raw foreign arrays, returns dicts keyed by each endpoint's `on` field. 1-1 sides via `keyBy`, 1-many "many" side via `groupBy`. Use the resulting index to attach per-row foreign data before `check()`.

### Engine

- **Root-array `check()` support** — when `data` is an array, the rule must be a tree of `all`/`any` whose leaves are fieldless `ArrayRule`s. Validated upfront via `validateRootArrayShape`; `ArrayRule.field` is now optional. `toPrisma`/`toSql` compilation of fieldless `ArrayRule`s is not yet implemented (future feature).

### Lens extends FieldMapSet (no more `map.maps` nesting)

`Lens` now extends `FieldMapSet` directly — `maps` and `bridges` live on the lens itself instead of being nested under a `map` field. `mapName` is required. Single-FieldMap callers wrap explicitly into `maps: { someName: fieldMap }` at construction.

Before:
```ts
const lens: Lens = {
  map: { maps: { prisma: myMap }, bridges: [...] },
  mapName: 'prisma',
  model: 'FanUser',
};
```

After:
```ts
const lens: Lens = {
  maps: { prisma: myMap },
  bridges: [...],
  mapName: 'prisma',
  model: 'FanUser',
};
```

The `'default'` magic-string fallback for single-map lenses is gone — `mapName` is always explicit.

### Hardening (adversarial review fixes)

- `stitchFieldMaps` validates `BridgeEndpoint.on` references a real field on the endpoint model; throws on self-bridges.
- `projectNarrowing` clones `bridges` (was aliased by reference) — projected mutations no longer leak into source.
- `checkRuleAgainstLens` is now context-aware — paths in `arrayRule`/`aggregate` conditions resolve against the relation target, not the lens root.
- `validateFieldMapSet` skips bridge entries (stitched outputs no longer fail validation for containing `:`).
- `getRoot` / `collectChain` detect cycles in narrowing parent chains via a visited set; throw clearly instead of looping.
- `StrictArrayRule.field` is now optional (matches the relaxed `ArrayRule` type).

### Compile-target changes

- `toPrisma`: emits `{}` (Prisma "match anything") for any predicate whose field path hits a bridge. No-op in AND, over-fetches in OR. Caller follows up with in-memory `check()` against hydrated cross-source data.
- `toPrisma`: normalizes `BuildOptions.map` at entry — if `mapName` is set, resolves `(map as set)[mapName]` to a single FieldMap; internal walkers unchanged.
- `toSql`: emits `'TRUE'` for any rule whose field path hits a bridge.

## 1.3.4

- Move `pg` to optional peerDependency, fix dayjs ESM imports.

## 1.3.3 and earlier

See git history.
