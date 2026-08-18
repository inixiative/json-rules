# src/lens/sourceValuesFromQueryRows.ts

## SourceRowShape

> `export type SourceRowShape = 'prisma' | 'sql';`

Which executor produced the rows — the caller always knows; never guessed.

## sourceValuesFromQueryRows

> `export const sourceValuesFromQueryRows = (`

Materialize one compiled `SourceQuery`'s fetched rows into its `SourceValues` —
the executor-side counterpart of `sourceQueries`, so apps never hand-map rows.
`rowShape` names the wire format: prisma rows (default) nest each `groupBy` axis
as related objects; sql rows carry them flat under the statement's `__group_i`
aliases. Grouped queries fetch without DISTINCT, so dedup per (groups, value)
happens here.
