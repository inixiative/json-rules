# Changelog

## 2.0.0

First version of the **Lens** primitive — schema-aware view layer with cross-source bridges and recursive narrowings. New compile-time boundary semantics in `toPrisma` and `toSql`.

### Breaking (type-level)

- `FieldMapEntry.kind` widened from `'scalar' | 'object' | 'enum'` to include `'bridge'`. Exhaustive `switch (kind)` consumers without a `default` will fail TS narrowing — handle the new kind or default to ignore.
- `BuildOptions.map` widened from `FieldMap` to `FieldMap | FieldMapSet`. Code that passed `options.map` straight to functions typed as `FieldMap` will need a cast or normalization (or use the new `mapName` field, which triggers automatic resolution at the toPrisma entry).

No runtime behavior changes for callers not using the new primitives.

### Added

- **`Lens`** — flat `{ map, mapName?, model }`. Destructures directly into `BuildOptions`.
- **`FieldMapSet`** — `Record<string, FieldMap>` for multi-source schemas.
- **`Bridge`** — bi-directional edge between two `(fieldMap, model)` endpoints with `cardinality: 'oneToOne' | 'oneToMany'`. Stitched as `kind: 'bridge'` pseudo-fields on each endpoint model.
- **`stitchFieldMaps(set, bridges)`** — injects bridges into a FieldMapSet.
- **`validateFieldMap` / `validateFieldMapSet`** — forbid `.`/`:` in field names; accumulate errors.
- **`LensNarrowing`** — recursive tree: `parent` → `maps[name].models[name]` with `picks`/`omits`/`constrains`/`relations`. Children narrow further only.
- **`validateNarrowing(narrowing)`** — structural + parent-chain cascade rules.
- **`projectNarrowing(lens)`** — produces the effective `FieldMapSet` after applying the narrowing chain.
- **`checkRuleAgainstLens(rule, lens)`** — walks rule AST, returns `{ ok, violations }` against the projected surface.

### Compile-target changes

- `toPrisma`: emits `{}` (Prisma "match anything") for any predicate whose field path hits a bridge. No-op in AND, over-fetches in OR. Caller follows up with in-memory `check()` against hydrated cross-source data.
- `toPrisma`: normalizes `BuildOptions.map` at entry — if `mapName` is set, resolves `(map as set)[mapName]` to a single FieldMap; internal walkers unchanged.
- `toSql`: emits `'TRUE'` for any rule whose field path hits a bridge.

## 1.3.4

- Move `pg` to optional peerDependency, fix dayjs ESM imports.

## 1.3.3 and earlier

See git history.
