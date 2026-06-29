# FEAT-004: Context bindings + lens identity/serialization (v3.0.0)

**Status**: 🆕 Proposed (RFC) — model converged in discussion 2026-06-29; sequencing + open items below, for review
**Assignee**: TBD
**Priority**: High
**Created**: 2026-06-29
**Updated**: 2026-06-29
**Target**: v3.0.0

Design discussion: template `INFRA-023` (problem framing + alternatives). This ticket is the json-rules-side implementation plan. **It is a proposal to react to, not a settled spec** — slices 4–7 in particular await review before building.

---

## Why a 3.0

Rules and narrowings need **runtime-bound values**. A `where` like "scope to the current tenant" can't be a literal (the tenant varies) and can't be a closure (closures aren't serializable — so a brandless config row, e.g. an email-template default, can't carry its own scope). Today the only mechanism is a runtime `scopeNarrowing((c) => …)` closure: code, not data.

The fix is a context-bind value (`{ bind }`) resolved from a supplied bindings map. **On its own that's additive (a minor).** But making it legible and serializable pulls in lens/narrowing **identity** and **serialization-by-ref**, which change the lens shape — those break, so the cohesive release is **3.0**, with bindings anchoring it.

## What's in 3.0

1. **`{ bind }` value source** — a third arm of `ValueSource<T>` (`{ value } | { path } | { bind }`), valid anywhere a value goes; resolved from a `bindings` map at execution. *(slice 1 ✅)*
2. **Bindings plumbing** — `bindings` threaded through `check` / `toPrisma` / `toSql` / `runSources`; a resolved bind is a query **parameter** in SQL/Prisma.
3. **Introspection** — `requiredBindings(lensOrRule)` and `describeBindings(lensOrRule)` (grouped by owning layer); a missing required bind throws at execution.
4. **Unique-name discipline + `parent:`** — bind names are unique within a composed narrowing chain; you can see the names a parent already occupies, and a collision **errors** (pick another name). To *intentionally* reuse an inherited binding, reference it explicitly as `parent:name` — read-only, resolved at the parent's stage, never rebindable by the child.
5. **Progressive (partial) resolution** — resolving a bindings map substitutes the names it covers and leaves the rest as tokens; `requiredBindings` shrinks. Execution requires it empty (else throw). Resolving only narrows, never widens.
6. **Intrinsic lens/narrowing identity** — every lens/narrowing carries a stable id/name in *both* object and ref-id forms (promotes INFRA-016's "stable identity" from serialize-only to intrinsic). Enables `describeBindings` grouping, `parent:`, and serialization.
7. **Serialization-by-ref + `seal`** (INFRA-016) — `serialize`/`deserialize` against source+bridge registries; `seal` for tenant→subtenant handoff. The dynamic `where` now serializes (binds as tokens), so a brandless default config row can carry its own scope.
8. **Projection folds bindings** — `projectByPath(lens, { bindings })` resolves binds server-side; `exposedSurface` stays `where`-stripped (binds never reach the client). Sourced options are resolved + scoped server-side; only the resolved value lists ship.

## Security model (converged)

The bar is **never reveal another tenant's data** — seeing your *own* bound values is fine ("it's your tenant"). Binds always resolve from the authenticated tenant context server-side, so a requester only ever sees its own scope. Therefore:

- **Source scoping is the one load-bearing invariant** — resolve bindings *before* hydrating a source query, so an option list is always tenant-scoped. An unscoped source query is the only path by which another tenant's rows reach you.
- `exposedSurface` strips `where` (and binds / `parent:` tags) — the client gets field names + resolved option values only.
- The returned client rule is re-validated (`checkRuleAgainstLens`) and the server's `where` re-applied (`applyLens`) — a tampered rule can't widen or reach a hidden field.
- Client-submitted rules carry no binds (binds are a narrowing/server concept) — reject/strip them.
- `parent:` references a *containing* scope (yours-or-above), never a sibling tenant; read-only.

## What breaks (3.0)

- Lens/narrowing objects gain an intrinsic `id`/name — shape change.
- New ref-id serialization format; `seal` output shape.
- Likely signature changes to make `bindings` first-class on `applyLens`/projection rather than optional add-ons (TBD — see open).
- *Non-breaking (additive):* the `{ bind }` arm and the optional `bindings` option on `check`/`toPrisma`/`toSql` — these alone wouldn't force a major.

## Slice order

1. ✅ **`{ bind }` + `check` path** — type arm, `CheckOptions.bindings`, `getValue` resolution (throws on missing). *Done on `feat/context-bind-values`; 3 tests; typecheck clean.*
2. **`requiredBindings` / `resolveBindings`** (flat, over a Condition) — collect names; substitute from a map; partial resolution leaves unresolved as tokens. + tests.
3. **`toPrisma` + `toSql`** — resolve binds → query parameter; aggregate rejects bind (parallels `path`). + tests.
4. **Intrinsic identity** — stable id/name on lens + narrowing, both forms. *(Breaking; gates 5–7.)* + tests.
5. **Layer-local resolution + `parent:`** — per-layer resolution down the chain; unique-name validation (collision errors); `parent:name` inherited read-only ref. + tests for the downward-only invariant.
6. **Sources-after-bindings** — `sourceQuery` resolves binds pre-hydration; `projectByPath` folds `{ bindings }`; `exposedSurface` stays where-stripped. + ordering/leak tests.
7. **Serialization-by-ref + `seal`** (INFRA-016) — serialize/deserialize the dynamic where; tenant→subtenant. + round-trip/leak tests.
8. **Docs + CHANGELOG + 3.0.0 cut.**

Slices 1–3 are additive / design-stable. **4 is the breaking pivot.** 5–7 encode the model + INFRA-016.

## Open — NOT decided, for review

- **Collision among concurrently-live tokens at one stage** — reject at compose, or auto-rename? (Leaning reject — matches "pick a better name.")
- **`parent:` reach** — since names are unique, does `parent:` just mean "inherited / filled upstream," or address a specific ancestor? (Leaning: intent marker; the name is already unique.)
- **Reserved-name set** — do occupied names include parent binds already resolved to literals, or only still-live ones?
- **`bindings` first-class vs optional** on `applyLens`/projection (drives part of "what breaks").
- **Identity: opaque id vs human-readable name** (INFRA-016's own open Q — names double as the ref + the qualifier).
