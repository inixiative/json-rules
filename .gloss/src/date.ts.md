# src/date.ts

## checkDate

> `const tz = resolveTimeZone(config, bindings);`

Resolve the anchoring zone ONCE (bind → literal → UTC) and normalize the config the
date-expression layer sees: honor a resolved zone when the caller set one, but leave
it unset otherwise so expression `now` resolution keeps its prior behavior.

> `const fieldDate = parseDateValue(fieldValue, tz);`

A naive field string is anchored in the resolved zone (default UTC); an absolute
instant (Date/number/zone-stamped string) is used as-is. Consistent with the
engine's config.timeZone policy used by dateExpr and both compilers.

## parseCompareDates

> `const [startDate, endDate] =`

Auto-sort: ensure startDate <= endDate

> `if (isPeriodExpr(condition.value)) {`

Bare period + before/after ⇒ implied edge (before→start, after→end).

> `if (condition.path.startsWith('$.')) {`

Support $.path for current element

> `return [dayjs(), undefined];`

Won't be used for dayIn/dayNotIn

## resolveTimeZone

> `export const resolveTimeZone = (`

The single seam that decides which timezone anchors a NAIVE (zoneless) value and frames
the dayIn/dayNotIn weekday, for ONE evaluation. Precedence: a zone bound from the
evaluation's `bindings` → a literal `config.timeZone` → 'UTC'. A future extension can
source a per-record zone here (see docs/TIMEZONE.md) without touching call sites.
Absolute instants never reach this seam — they bypass anchoring entirely.

## TRAILING_OFFSET

> `const TRAILING_OFFSET = /[+-]\d{2}:?\d{2}$/;`

Detects an explicit zone on a date STRING only (never String(Date), whose render is
host-locale-dependent): a trailing `Z`, or a `±HH:MM`/`±HHMM` offset after the time.

## parseDateValue

> `export const parseDateValue = (value: DateInputValue | undefined, tz: string): dayjs.Dayjs => {`

Parse a comparison/field value into an instant, given the already-resolved anchor zone.
- Date object / epoch number → absolute instant, used as-is (never anchored).
- String with an explicit zone (`Z` or `±HH:MM` after a time) → absolute.
- Naive string (date-only or zoneless datetime) → anchored in `tz` via dayjs.tz; a
  date-only string becomes midnight in that zone.

> `const base = dayjs(value);`

dayjs.tz throws on an unparseable string; return the (invalid) base parse instead
so callers' isValid() checks surface the friendly "not a valid date" error.
