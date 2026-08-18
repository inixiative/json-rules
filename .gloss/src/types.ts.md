# src/types.ts

## RelativeUnits

> `export type RelativeUnits = {`

--- Relative & calendar date expressions (v2.6.0) ---
Positive magnitudes only; direction lives in the keyword. Units are dayjs words.

## RollingExpr

> `export type RollingExpr = { ago: RelativeUnits } | { ahead: RelativeUnits };`

Point expressions — resolve to a single instant.

## DateExpr

> `export type DateExpr = RollingExpr | PeriodExpr | EdgeExpr;`

A date expression is either a point (rolling/edge) or a range (period/rolling).

## TimeZoneConfig

> `export type TimeZoneConfig = string | { bind: string };`

The anchoring timezone for naive datetimes. Either a literal IANA zone string, or a
bound reference resolved from the evaluation's `bindings` (same bind mechanism as rule
values). Stays ONE zone per evaluation; absolute instants never consult it.

## SortDir

> `export type SortDir = 'asc' | 'desc';`

--- Windowing selector (v2.6.0) ---
Ordered selection on array/aggregate rules. Pipeline: order → skip → take.

## Rule

> `coerceType?: FieldKind;`

Declared kind both sides coerce to before comparing — never inferred from the
values. Stamp mechanically from a lens via stampCoercions().
