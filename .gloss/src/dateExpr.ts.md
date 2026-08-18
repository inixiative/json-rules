# src/dateExpr.ts

## isDateExpr

> `export const isDateExpr = (value: unknown): value is DateExpr => {`

True when a DateRule `value` is a structured date expression rather than an absolute date.

## requireNow

> `const zone = typeof config.timeZone === 'string' ? config.timeZone : undefined;`

Only a literal zone string anchors `now` here; the bind form is resolved upstream (in
checkDate, which normalizes config.timeZone to a concrete string) — there are no
bindings at this layer (compilers), so a non-string zone means "no static anchor".

## effectivePeriodUnit

> `const effectivePeriodUnit = (unit: PeriodUnit, config: DateConfig): dayjs.OpUnitType => {`

`week` is governed by weekStart (default monday → isoWeek). `isoWeek` is always Monday.

## resolvePeriodRange

> `export const resolvePeriodRange = (`

Resolve a calendar period (this/last/next) to its [start, end] boundaries.

> `const stepUnit = (unit === 'isoWeek' ? 'week' : unit) as dayjs.QUnitType;`

Step whole periods first, then snap — robust to month-length clamping.

## resolveDateExpr

> `export const resolveDateExpr = (expr: DateExpr, config: DateConfig): dayjs.Dayjs => {`

Resolve a point expression (for before/after/onOrBefore/onOrAfter).
Rolling → the offset instant; edge → the named boundary of a period.

## resolvePointForOperator

> `export const resolvePointForOperator = (`

Resolve the single comparison point for before/after/onOrBefore/onOrAfter.
Bare period → implied edge (before/onOrBefore → start; after/onOrAfter → end).
Rolling/edge → their point. Shared by check, toPrisma, and toSql.

## resolveDateExprRange

> `export const resolveDateExprRange = (`

Resolve a range expression (for `within`).
Period → its [start, end]; rolling → [now-Δ, now] / [now, now+Δ].
