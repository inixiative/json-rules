# src/lens/policy.ts

## VisitEffect

> `sourceLabels: Map<string, string>;`

Per-field display-label column (from a SourceSpec's `label`); a later layer wins.

> `sourceGroupBys: Map<string, string[]>;`

Per-field option-partition axes (from a SourceSpec's `groupBy`, normalized); a later layer wins.

## normalizeGroupBy

> `export const normalizeGroupBy = (g: string | string[] | undefined): string[] | undefined =>`

Normalize a `groupBy` declaration to its axes array (a bare string is one axis).

## isSourceSpec

> `export const isSourceSpec = (v: SourceValue): v is SourceSpec =>`

A `sources` entry is a `SourceSpec` when it carries `where`/`label`/`groupBy`; else it's a bare `Condition`.

## normalizeSource

> `export const normalizeSource = (v: SourceValue): SourceSpec => {`

Normalize a `sources` entry to a `SourceSpec` — a bare `Condition` becomes its `where`.

## accumulateInto

> `out.sources.set(field, clauses);`

register the field even when only a label is set

## resolveVisit

> `const optionValues = entry.options?.map((o) => o.value);`

Enums draw from the registry; any other kind (scalar, Json) is gated by an explicit
`values` set. A hydrated source's folded `options` gate too and win when present — a
consumer re-feeds an exposed surface here, so this is load-bearing (see
test/lens.sourceOptionsGating.test.ts).

## walkLensPath

> `jsonSubPath: string[];`

Segments consumed below a Json boundary — empty when the path ends on the declared entry.

> `if (isJsonEntry(entry) && i < parts.length - 1) {`

A Json column has no declared sub-fields; a dotted sub-path into it is resolved
by the evaluators/compilers (check/toPrisma/toSql), so the field resolves to the
visible Json column — stop here and treat it as the terminal.
