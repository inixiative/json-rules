# src/lens/bindings.ts

## modelNodeConditions

> `const modelNodeConditions = (n: ModelDefaultNarrowing | ModelNarrowing): Condition[] => {`

Every Condition a model node carries: its own `where`, each `sources` where,
and the same recursively for path-specific relations.

## layerConditions

> `const layerConditions = (nrw: LensNarrowing): Condition[] => {`

Every Condition one narrowing layer carries (root + mapDefaults).

## declaredNames

> `const declaredNames = (nrw: LensNarrowing): Set<string> => {`

Bind names a layer *declares* (introduces). `parent:` tokens are inherited
references, not declarations.

## lensRequiredBindings

> `export const lensRequiredBindings = (lensOrNarrowing: Lens | LensNarrowing): Set<string> => {`

Every bind name a lens (its whole narrowing chain) needs supplied to execute.
`parent:` references collapse to their base name — the caller supplies one value
per name and an inherited reference draws the same one. This is the "what does
this lens require" answer; pass `narrowing.parent` to see the names a child must
not collide with.

## resolveLensBindings

> `export const resolveLensBindings = (`

Preprocess a lens: resolve every `{ bind }` token the map covers in the chain's
`where`/`sources`, returning a structurally-new lens with concrete conditions.
Partial — uncovered tokens stay, so stages bind progressively. Once resolved,
`applyLens` / `toPrisma` / `toSql` / `sourceQueries` / `projectByPath` consume the
lens unchanged: a bind needs nothing new downstream. `parent:name` draws the same
value as the ancestor's `name`. Does not mutate the input.

> `if (isLens(lensOrNarrowing)) return lensOrNarrowing;`

a bare lens carries no where/sources

## validateBindNames

> `export const validateBindNames = (narrowing: LensNarrowing): string[] => {`

Bind names are unique across a composed chain: a layer may not re-declare a name
an ancestor already declares — rename it, or reference the inherited one read-only
as `parent:name`. A `parent:name` reference must point at a name some ancestor
actually declares. Returns the violation messages (folded into `validateNarrowing`).
