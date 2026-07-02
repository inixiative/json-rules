# Datetime timezone policy

json-rules evaluates and compiles datetimes against a single, explicit timezone policy
so results are deterministic — never dependent on the host machine's timezone.

## The policy

- **Absolute instants are never anchored.** A `Date` object, an epoch `number`, or an ISO
  string carrying an explicit zone (a trailing `Z`, or a `±HH:MM` offset after the time)
  denotes one exact instant and is used as-is.
- **Naive values are anchored in the evaluation's timezone.** A zoneless string — a
  date-only `YYYY-MM-DD` (which becomes midnight in that zone) or a datetime with no zone —
  is interpreted in the resolved timezone. This applies to both the rule's comparison value
  and the field value.
- **`dayIn` / `dayNotIn` weekdays are computed in that same timezone**, not host-local.

## Resolving the zone (`resolveTimeZone`)

There is a single resolver seam (`resolveTimeZone` in `src/date.ts`). It resolves the
anchoring zone for **one evaluation**, with this precedence:

1. **Bound zone** — when `config.timeZone` is `{ bind: '<key>' }` and the key is present in
   the evaluation's `bindings`, that bound string wins. This reuses the same bind mechanism
   rule values use, so the zone can travel with the request/context rather than being
   hard-coded.
2. **Literal zone** — a plain IANA string `config.timeZone`.
3. **`'UTC'`** — the default, including when a bound key is absent.

`config.timeZone` is therefore typed `string | { bind: string }` (`TimeZoneConfig`). The
date-expression layer (`now`, `this month`, …) and the SQL/Prisma compilers see a concrete
string: `checkDate` normalizes the bound form to a resolved string before threading it down.

## Not built: per-record (companion-column) zones

A future need: a single record holds two datetimes authored in **different** zones — e.g.
an event with `startsAt` and `endsAt` where the intended wall-clock zone lives in a sibling
column such as `startsAtTimeZone` (read per-record, per-field), not once per evaluation.

Sketch for when that lands:

- Declare the companion zone column on the field in the lens / fieldmap (e.g. a field-level
  `timeZoneField: 'startsAtTimeZone'` pointing at the sibling scalar that holds the IANA
  string for that datetime).
- Read it alongside the value and feed it through the same `resolveTimeZone` seam, so a
  per-field zone overrides the per-evaluation zone only for that field. Absolute instants
  still bypass anchoring entirely.

This keeps one resolution point; only its inputs widen (per-evaluation → optionally
per-field). It is intentionally **not** implemented yet — documented here so the intent is
on record.
