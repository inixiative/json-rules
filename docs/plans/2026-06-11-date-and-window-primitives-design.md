# Design: Date & Window Primitives (v2.6.0)

**Date**: 2026-06-11
**Target version**: 2.6.0 (additive minor — new operator, new `value` shapes, new windowing keys)
**Status**: Designed, not started
**Supersedes/expands**: FEAT-001 (relative date expressions)
**New ticket**: FEAT-003 (windowing selector)

---

## Motivation

Two capability gaps, surfaced by rules like:

> _"user whose **last fanMission** was **more than 30 days ago**"_

That single rule needs both:

1. **Relative / calendar date expressions** authored *in* the rule (no caller pre-computation) — "more than 30 days ago", "this month", "before last month".
2. **Ordered windowing** — "the last fanMission" = order by date desc, take 1 — then predicate against that window.

Both must stay pure/serializable and run on all three execution targets (`check`, `toPrisma`, `toSql`) **best-effort**.

---

## Part 1 — Date value expressions

A `DateRule`'s `value` gains structured expressions alongside absolute dates. Two
core principles, agreed during design:

- **Positive magnitudes only.** Direction is never carried by a sign — it lives in
  the keyword (`ago`/`ahead`, `this`/`last`/`next`) and in the operator.
- **No new jargon.** Units are dayjs's own full words.

### Units

`day`, `week`, `isoWeek`, `month`, `quarter`, `year`, `hour`, `minute`, `second`.

- Full words only (avoids dayjs's `M` = month / `m` = minute shorthand trap).
- `quarter` requires the `quarterOfYear` plugin (already vendored).
- **`week` is governed by the `weekStart` config** (default `monday` → isoWeek,
  Mon–Sun). See [Configuration](#configuration).

### Point expressions

Resolve to a single instant. Pair with `before` / `after` / `onOrBefore` /
`onOrAfter`, or as endpoints of `between` / `notBetween`.

| Expression | Meaning |
| --- | --- |
| `{ ago: { days: 30 } }` | `now − 30 days` (rolling, into the past) |
| `{ ahead: { months: 2 } }` | `now + 2 months` (rolling, into the future) |
| `{ start: <period> }` | the start boundary of a calendar period |
| `{ end: <period> }` | the end boundary of a calendar period |

`ago`/`ahead` accept multiple units: `{ ago: { months: 1, days: 15 } }`.

### Range expressions

Resolve to `[start, end]`. Pair with the **new `within` operator**.

| Expression | Range |
| --- | --- |
| `{ this: 'month' }` | `[startOf(month), endOf(month)]` of the current period |
| `{ last: 'week' }` | the immediately previous period |
| `{ next: 'quarter' }` | the immediately following period |
| `{ ago: { days: 30 } }` | `[now − 30d, now]` (rolling window) |
| `{ ahead: { days: 7 } }` | `[now, now + 7d]` (rolling window) |

`this`/`last`/`next` are **single-step** (current / previous / following). Multi-step
windows use rolling `ago`/`ahead` (e.g. "last 3 months" = `{ ago: { months: 3 } }`).

### Operators

- **New: `within`** — field falls inside a range expression.
- `between` / `notBetween` keep their meaning: **two explicit points**, `value: [a, b]`.
- `before` / `after` / `onOrBefore` / `onOrAfter` — point comparison.

### Implied edges

A **bare period** with `before` / `after` resolves to the only sensible edge:

- `before { last: 'month' }` ⇒ before the **start** of last month
- `after  { next: 'month' }` ⇒ after the **end** of next month

`{ start: … }` / `{ end: … }` remain available to name the *non-default* edge
(e.g. `before { end: { last: 'month' } }` = "before last month ended").

### Examples

```ts
// more than 30 days ago
{ field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } }

// within the last 30 days
{ field: 'completedAt', dateOperator: 'within', value: { ago: { days: 30 } } }

// within the next 7 days
{ field: 'dueAt', dateOperator: 'within', value: { ahead: { days: 7 } } }

// this month
{ field: 'completedAt', dateOperator: 'within', value: { this: 'month' } }

// last month
{ field: 'completedAt', dateOperator: 'within', value: { last: 'month' } }

// before last month  (implied start edge)
{ field: 'completedAt', dateOperator: 'before', value: { last: 'month' } }

// after next month   (implied end edge)
{ field: 'completedAt', dateOperator: 'after',  value: { next: 'month' } }

// between 90 and 30 days ago (two explicit points)
{ field: 'completedAt', dateOperator: 'between', value: [{ ago: { days: 90 } }, { ago: { days: 30 } }] }
```

### `now` contract

`now` is an **explicit evaluator input** — no implicit `Date.now()` inside the
library (keeps `check`/`toPrisma`/`toSql` deterministic and resolvable). Any path
that encounters a relative/period expression **throws if `now` was not supplied**.
Resolution: `check()` resolves at eval time; `toPrisma`/`toSql` resolve to concrete
bounds at **compile time** from `now`, then emit ordinary predicates.

### Configuration

`timeZone` and `weekStart` are **evaluation context**, delivered **per-call only**
(no global singleton, no `createEvaluator` helper) — the same purity/multi-tenant
argument as `now`. A global mutable default would reintroduce hidden input and is
wrong for a multi-tenant process (NY tenant + London tenant share one runtime).

```ts
check(rule, data, { now, timeZone, weekStart });
toPrisma(rule, { map, model, now, timeZone, weekStart });
toSql(rule,    { map, model, now, timeZone, weekStart });
```

| Option | Default | Governs |
| --- | --- | --- |
| `now` | — (**required** when a relative/period expr is present) | the anchor instant |
| `timeZone` | `'UTC'` | how `now`, period boundaries, and bare-date parsing localize. **Not** machine-local (that's non-deterministic across hosts). |
| `weekStart` | `'monday'` (ISO 8601, isoWeek) | start of `week` for `this/last/next` and `startOf/endOf('week')` |

`now`/`timeZone`/`weekStart` share one options bag but differ in lifecycle: `now`
changes every call; `timeZone`/`weekStart` are stable policy a host repeats (or
omits to take the default).

**Determinism requirement — config must compile into all three targets
identically.** `toSql` emits `AT TIME ZONE` and the matching `date_trunc` / DOW
logic; otherwise `check()` and `toSql()` would disagree on "this week" / "start of
month." This reconciles with the existing offset-aware parsing in `date.ts`
(`parseDateWithTimezone`), which must defer to `timeZone` for bare (offset-less)
dates.

---

## Part 2 — Windowing selector

Ordered selection on `ArrayRule` and `AggregateRule`. **Flat** keys (chosen during
design) sit alongside the predicate keys:

```ts
{
  field: 'fanMissions',
  orderBy: [{ field: 'completedAt', dir: 'desc' }, { field: 'id', dir: 'asc' }],
  take: 1,          // optional; positive — count from the front of the ordered list
  skip: 0,          // optional; positive offset
  arrayOperator: 'all',
  condition: { field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } },
}
```

### Semantics

- `orderBy` — array of `{ field, dir: 'asc' | 'desc' }`. Multi-key, applied in order.
  Maps 1:1 onto Prisma `orderBy` / SQL `ORDER BY` / lodash `orderBy`.
- Pipeline: **order → skip → take**, producing a sub-array.
- Direction is `orderBy`'s `dir`. There is **no `first`/`last` keyword** — "last
  fanMission" is `order by completedAt desc, take 1`. (`last`/`first` were rejected:
  `last` collides with the date `{ last: 'month' }` vocabulary, and `take`/`skip` is
  Prisma's own language.)
- The existing predicate (`arrayOperator` + `condition`, or `aggregate`) evaluates
  the **windowed** sub-array. No new predicate vocabulary.

### Empty-window semantics

The engine picks **no** pass/fail default. The author expresses intent through the
array operator, using standard semantics:

- `all` → vacuously **true** on an empty window
- `atLeast: 1` / `any` → **false** on an empty window

"Most-recent mission is >30d ago **and one exists**" = `all` on the windowed element
**AND** `notEmpty` / `atLeast: 1`. "…or they have none" = just `all`. Both
expressible; no magic.

---

## Part 3 — Compilation (best-effort)

| Path | Dates | Windowing |
| --- | --- | --- |
| `check()` | Full | Full — all `orderBy`/`take`/`skip` shapes |
| `toPrisma` | Full (resolve bounds at compile time) | **Extremal only** |
| `toSql` | Full (resolve bounds at compile time) | **Extremal only** |

**Extremal rewrite** (`take: 1`, no `skip`): an ordered take-1 + comparison is
logically an existence/none predicate, which a `WHERE` clause *can* express.

- `all` on the windowed element ⇒ `none { … }` (no row violates the bound)
- existence (`notEmpty` / `atLeast: 1`) ⇒ `some { … }`

e.g. "most-recent fanMission before T" ⇒ `fanMissions: { none: { completedAt: { gte: T } } }`.
The existence guard appears **only when the author wrote it** (per empty-window rule).

**General `take: N` (N>1) or any `skip`**: needs window functions / lateral joins
that don't fit a `WHERE` fragment. `toPrisma`/`toSql` **throw a clear
"unsupported on this backend" error** rather than emitting wrong output. `check()`
still handles them.

---

## Type / API surface

- `operator.ts`: add `within` to `DateOperator`.
- `types.ts`:
  - `DateRuleValue` gains the point/range expression union (`AgoExpr`, `AheadExpr`,
    `PeriodExpr` (`this`/`last`/`next`), `EdgeExpr` (`start`/`end`)).
  - `ArrayRule` / `AggregateRule` gain optional `orderBy`, `take`, `skip`.
  - `OrderBy = { field: string; dir: 'asc' | 'desc' }[]`.
- Evaluator inputs `now` / `timeZone` / `weekStart` carried on the **existing**
  options bags — extend `CheckOptions` (`check.ts`, today only `{ context? }`) and
  the `toPrisma`/`toSql` options types. No new positional arg.
  - **Plumbing gap**: `check()` currently passes only `opts.context` into
    `checkDate` (`check.ts:43`). `checkDate`'s signature — and the field/aggregate
    paths that can nest date conditions — must be widened to receive the date
    config, not just `context`.
- `validate.ts`: validate unit words, positive magnitudes, operator↔value-shape
  pairings (`within` ⇒ range, `before`/`after` ⇒ point or bare-period), `orderBy`
  field shape, positive `take`/`skip`, and backend-support gating.
- Operator catalog: register `within`; document value-shape requirements.

---

## Open questions

- **`start`/`end` of a rolling `ago`/`ahead`** — disallow (only periods have named
  edges) vs allow. Lean: disallow; `ago`/`ahead` are already points.
- **SQL period boundaries** — `date_trunc` covers `this`; `last`/`next` need
  `± interval` around the trunc. Confirm dialect coverage (ties into FEAT-002).

---

## Definition of Done (v2.6.0)

- [ ] `within` operator + point/range value expressions in `check`, `toPrisma`, `toSql`
- [ ] `now` contract enforced (throws when missing) across all three paths
- [ ] `orderBy`/`take`/`skip` windowing in `check`; extremal rewrite in `toPrisma`/`toSql`;
      clear throw for unsupported window shapes
- [ ] Validator + operator-catalog coverage
- [ ] README + support-matrix updated
- [ ] Driving rule ("last fanMission > 30 days ago") passes on all three targets where supported
