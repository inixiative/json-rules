# src/lens/projectByPath.ts

## ProjectedVisit

> `sources: Record<string, Condition[]>;`

Per-field source eligibility wheres, composed across layers (general + path).

> `sourceLabels: Record<string, string>;`

Per-field display-label column for a sourced field (from a SourceSpec's `label`).

> `sourceGroupBys: Record<string, string[]>;`

Per-field option-partition axes for a sourced field (from a SourceSpec's `groupBy`).

## SourceValues

> `export type SourceValues = {`

The materialized option set for one sourced field — the fetched companion to a
serializable lens. Its `options` are `{ value, label? }` pairs (the standard
`<select>` shape); it feeds both projections: `projectByPath` keys by
`path`+`field` (exact), `exposedSurface` by `mapName`+`model`+`field` (union).

## projectByPath

> `const options = fetchedOptions ?? enumValues?.map((v) => ({ value: v, label: v }));`

A sourced field's fetched pairs win; otherwise a value-gated field surfaces
its resolved allowed-set as options, so every selectable field exposes `options`.
