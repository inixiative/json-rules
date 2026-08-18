# src/lens/sourceOptions.ts

## foldPathGuards

> `const foldPathGuards = (`

Fold the traversal guards one dotted path picks up: every traversed model's
effective narrowing `where` (tenancy/soft-delete) — declared relation nodes AND
mapDefaults, composed across all layers via `resolveVisit` — re-rooted onto the
sourced model, the same hop-where fold `applyLens` performs for rule paths. The
compile always joins every hop the path names, so every hop must carry its guard
whether or not the narrowing declares it.

`strict` (groupBy axes): an unresolvable hop is fail-closed — throw.
Lenient (where-clause field paths): stop at the first non-relation segment (a
plain column, or a Json column with a sub-path tail) — no join past it exists.
`seen` dedups hops shared across paths: one guard fold per traversed node.

> `for (let i = 0; i < segments.length - 1; i++) {`

The last segment is the column; guards live on the traversed models.

> `return;`

plain column / Json sub-path — nothing joins past here

## collectFieldPaths

> `const collectFieldPaths = (condition: Condition, out: string[] = []): string[] => {`

Every dotted `field` a condition references (all/any/if recursion; array and
aggregate rules contribute their own anchor `field` — their nested conditions
are element-relative and compile inside the relation filter, not as new joins
from this model).

## traversalGuards

> `export const traversalGuards = (`

The composed traversal guards for one source: guards for every groupBy axis
(strict) and for every relation path its `where` clauses reference (lenient) —
the where ships those joins just as surely as the group select does. Hops are
folded once each across all paths.

## groupAtPath

> `export const groupAtPath = (row: Row, path: string): string | undefined => {`

Walk a dotted to-one path through nested row objects; undefined when unreachable.

## groupsAtPaths

> `export const groupsAtPaths = (row: Row, paths: readonly string[]): string[] | undefined => {`

Resolve every axis for a row — all-or-nothing: any unreachable axis leaves the
option ungrouped. A partial key would make partition pins unpredictable.

## optionKey

> `export const optionKey = (groups: readonly string[] | undefined, value: string): string =>`

Dedup key — options are unique per (groups, value), not per value.

## accumulateOption

> `export const accumulateOption = (`

Merge one occurrence into the accumulator; the first non-null label wins.

## sortOptions

> `export const sortOptions = (byKey: Map<string, SourceOption>): SourceOption[] =>`

Fixed locale: host-locale sorting would make option order machine-dependent.
Ungrouped options are their own leading tier — an empty-string DB label is a
real group and must never interleave with "no group". Grouped options order by
their axes lexicographically, then label/value.
