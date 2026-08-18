# src/lens/types.ts

## Lens

> `mapName: string;`

which map in `maps` the anchor model lives in

## ModelDefaultNarrowing

> `export type ModelDefaultNarrowing = {`

Narrowing applied wherever a model appears (intrinsic to the model).
Has no `relations` because relations are path-specific by definition.

Two kinds of narrowing live here:
- SCHEMA narrowing (picks/omits/enumPicks/enumOmits): controls what's visible
  in the type surface. AI/SDK consumers can't see narrowed-away fields.
- DATA narrowing (where): controls which ROWS are in scope. Filter-first
  semantic, anchored to the model. Under arrayOperator: 'all', applied via
  implication (negate) to preserve filter-first meaning — see applyLens.

> `enumPicks?: Record<string, readonly string[]>;`

fieldName → allowed enum values

> `enumOmits?: Record<string, readonly string[]>;`

fieldName → denied enum values

> `where?: Condition;`

Row-level filter anchored to this model — "from what you can see, this is true."
Composes via filter-first semantic at every visit of this model.

> `sources?: Record<string, SourceValue>;`

Per-field eligibility over THIS model — decorates a field's option picker.
A bare `Condition` is the eligibility `where`: the field's selectable values =
DISTINCT(field) over this model filtered by `where` (plus the model's own
narrowing). A `SourceSpec` adds an optional `label` — a sibling column on this
same model co-selected as each value's display label. Referenced-model option
sets need no special form: declare the source at a relation-traversed narrowing
node and it compiles over whatever model that path resolves to. The `where`
composes AND-only across layers (general via `mapDefaults`, path-specific via
`root`/`relations`); a later layer's `label` wins.
fieldName → eligibility where | SourceSpec

## SourceSpec

> `export type SourceSpec =`

A sourced field's eligibility `where` plus an optional sibling display-label column
and an optional `groupBy` — a dotted path (to-one hops only, ending on a scalar)
whose value partitions the option set. Grouped options carry `group`; the classic
flat set is the ungrouped case. At least one key is required — `{}` is not a
Condition; the unconstrained spelling is `true`.

## SourceValue

> `export type SourceValue = Condition | SourceSpec;`

A `sources` entry: a bare eligibility `Condition`, or a richer `SourceSpec`.

## ModelNarrowing

> `export type ModelNarrowing = ModelDefaultNarrowing & {`

Narrowing for a model at a specific traversal path. Adds relations to the default shape.

## EnumNarrowing

> `export type EnumNarrowing = {`

Narrowing for an enum type (applies anywhere the enum is referenced).

## NarrowingDefaults

> `export type NarrowingDefaults = {`

Applies-everywhere narrowings for one map — per-model (no relations) + per-enum-type.

## LensNarrowing

> `parent: Lens | LensNarrowing;`

TODO: may need to be an identifier (lens name/uuid) rather than a direct reference for persistence

> `root?: ModelNarrowing;`

Path-specific narrowing anchored at (lens.mapName, lens.model). Descends via
`.relations` and may cross maps through bridge relations.

> `mapDefaults?: Record<string, NarrowingDefaults>;`

Per-map applies-everywhere narrowings, keyed by map name. Apply wherever the
named model/enum appears in the visit being resolved.
