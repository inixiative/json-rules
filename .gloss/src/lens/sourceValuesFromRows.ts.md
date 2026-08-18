# src/lens/sourceValuesFromRows.ts

## rowsAtPath

> `const rowsAtPath = (rows: readonly Row[], path: string): Row[] => {`

Rows anchored at a projection path: segments after the root model name descend
relations, flattening to-many arrays (mirrors the joins a SourceQuery would emit).

## sourceValuesFromRows

> `export const sourceValuesFromRows = (`

Materialize each sourced field's option set from an already-fetched collection —
the in-memory executor of `sources` declarations, alongside `sourceQueries`
(which compiles the same declarations to DISTINCT queries for a DB). Rows are
the collection fetched UNDER the lens (relations inline), so they are already
lens-scoped: eligibility here is the field's source `where` only, evaluated via
`check()` (`options` feeds `{bind}` clauses). Scalar-list fields contribute one
option per element, labels take the first non-null sibling, and sorting is
numeric-aware in a fixed locale. Feed the result to `exposedSurface` /
`projectByPath` as `{ sourceValues }`.

> `const groups = groupBy === undefined ? undefined : groupsAtPaths(row, groupBy);`

Any unreachable axis (null hop) → the option stays ungrouped, never partial.
