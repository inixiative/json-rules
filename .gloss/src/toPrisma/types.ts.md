# src/toPrisma/types.ts

## SourceOption

> `export type SourceOption = { value: string; label?: string; groups?: string[] };`

A selectable option — the standard `<select>` shape: a value with an optional display
label, plus the partition keys (index-aligned with the source's `groupBy` axes)
when the source is grouped.

## FieldMapEntry

> `export type FieldMapEntry = {`

FieldMap is structurally compatible with PrismaMap from @inixiative/prisma-map.
It only requires the fields that json-rules needs for traversal.

> `relationName?: string;`

disambiguates multiple relations between same two models

> `values?: readonly string[];`

Per-field allowed values, primarily for enum fields. Takes precedence over
`FieldMap.enums[type]` if both are set. Pass-through from codegen
(e.g. prisma-map's `EnumField.values`). Consumed by `checkRuleAgainstLens`.

> `options?: readonly SourceOption[];`

A field's selectable option set as `{ value, label? }` pairs — the display
shape a picker consumes. On projection/surface output this is populated for
every value-gated field (enum members normalized to `{ value, label: value }`)
and for sourced fields (the fetched pairs from a materialized `SourceValues`).

> `groupBy?: readonly string[];`

Present on projection/surface output when the field's source partitions its
options: the dotted to-one axes (relative to this model) whose values are
each option's `groups`, index-aligned.

## FieldMap

> `export type FieldMap = {`

A schema map: models keyed by name, plus an optional enum registry scoped to
this source. In multi-source setups (Prisma + Salesforce + CRM) each FieldMap
carries its own enums so namespaces don't collide across sources.

> `enums?: Record<string, readonly string[]>;`

Enum name → allowed values, e.g. `{ UserRole: ['ADMIN', 'USER'] }`.

## ToPrismaResult

> `export type ToPrismaResult = {`

steps is always present; the last entry is always a WhereStep.
GroupBySteps precede it when count-based relation filtering is needed.

## PrismaBuildState

> `export type PrismaBuildState = {`

Mutable state threaded through build calls to accumulate intermediate groupBy steps
