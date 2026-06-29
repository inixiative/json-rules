# FEAT-004: Context bindings — serializable dynamic `where`

**Status**: 🟢 Core built — `feat/context-bind-values` / PR #4. Model decided 2026-06-29 (Aron).
**Assignee**: Aron
**Priority**: High
**Created**: 2026-06-29
**Updated**: 2026-06-29
**Target**: **2.11.0** — additive under the decided design (decided 2026-06-29).

Design discussion: template `INFRA-023`. Motivating consumer: Zealot per-slug email narrowings (ZLT-3169) — a brandless default template must carry its own tenant-scoped narrowing as config, which a runtime `scopeNarrowing((c) => …)` closure can't do.

---

## The decision that shrank this ticket

A bind **preprocesses into the lens** — you resolve `{ bind }` tokens into the chain's `where`/`sources` *first*, producing a structurally-new lens with concrete conditions, and then `applyLens` / `toPrisma` / `toSql` / `sourceQueries` / `projectByPath` / `exposedSurface` all consume it **unchanged**. A bind needs **nothing new downstream**.

That single call removes everything that would have made this a heavy 3.0:

- ❌ ~~`bindings` threaded through `toPrisma` / `toSql` / `runSources`~~ — they receive an already-concrete lens.
- ❌ ~~intrinsic lens/narrowing identity~~ — bind names are unique across the chain, so the **name is the key**; `parent:` is the qualifier. No assigned ids needed.
- ❌ ~~`projectByPath` folds a `bindings` option~~ — resolve the lens, then project.
- ❌ **`seal`** — dropped (INFRA-016). The server is the sole executor and each party authors only its own layer, so the parent floor is structural (chain compose + narrow-only + server-side bind resolution) — there's no off-server handoff to seal.
- ⏸️ **serialization-by-ref** — its own ticket (INFRA-016), and the email path doesn't need it: store the narrowing delta and reattach a code-built parent at load. Ref-id only matters when the base lens itself is persisted/registry-driven.

## What's built (PR #4)

Core (Condition-level, additive — slices 1–2):
- **`{ bind }` value source** — third arm of `ValueSource<T>` (`{ value } | { path } | { bind }`), valid anywhere a literal goes (equality, comparison, in/notIn, between, aggregate; date rules extend identically). A narrowing `where` reads `{ field: 'brandUuid', operator: 'equals', bind: 'brandUuid' }` — serializable, brandless.
- **`check(rule, data, { bindings })`** — resolves a bind from the supplied map; **throws** on a missing required bind (a forgotten tenant scope is a caller bug, never silently zero rows).
- **`requiredBindings(condition)` → `Set<string>`** and **`resolveBindings(condition, bindings)`** — collect names; substitute the names the map covers, leave the rest as tokens (partial / progressive). Non-mutating.

Lens-level (additive — the "preprocess into the lens" entry point):
- **`resolveLensBindings(lensOrNarrowing, bindings)`** — resolves binds across the whole chain's `where`/`sources` (recursing relations + mapDefaults), returning a new lens. Partial-safe. Non-mutating.
- **`lensRequiredBindings(lensOrNarrowing)` → `Set<string>`** — what the lens needs; `parent:` refs collapse to base names. Pass `narrowing.parent` to **see the names a child must not collide with**.
- **`validateBindNames(narrowing)`** (folded into `validateNarrowing`) — enforces the discipline below.

## The discipline (decided)

- **Unique names + collision = error.** A layer may not re-declare a bind name an ancestor already declares; `validateNarrowing` throws and names the collision so the author picks a better one ("you should be able to see parent").
- **`parent:name` for intentional reuse** — a child references an inherited binding read-only as `parent:brandUuid`; it draws the same value as the ancestor's `brandUuid`, is excluded from the collision check, and a `parent:` ref no ancestor declares is rejected. This *is* the layer-local / downward-only invariant: a child can reference but never re-bind a parent's scope.

## Security model (unchanged)

The bar is **never reveal another tenant's data** — seeing your *own* bound values is fine ("it's your tenant"). Binds resolve from the authenticated tenant context server-side.

- **Resolve before hydrating a source query** — so an option list is always tenant-scoped. An unscoped source query is the only path by which another tenant's rows reach you. (`resolveLensBindings` → then `sourceQueries`.)
- `exposedSurface` strips `where` (and any unresolved binds / `parent:` tags) — the client gets field names + resolved option values only.
- The client's returned rule is re-validated (`checkRuleAgainstLens`) and the server's `where` re-applied (`applyLens`) — a tampered rule can't widen or reach a hidden field. Client rules carry no binds; reject/strip them.

## Semver — 2.11.0 (decided)

Under "preprocess into the lens, nothing new downstream," the whole feature is **additive** (a new union arm + new functions + a new validation that can only fire on binds, which didn't exist before) → a **minor, 2.11.0**. The 3.0 framing was carrying the lens identity/serialization rework, now out of scope (`seal` dropped; serialization-by-ref is its own INFRA-016 ticket).

## Deferred / out of scope

- **`seal`** — dropped (see above + INFRA-016). No off-server execution → nothing to seal.
- **Serialization-by-ref** (INFRA-016) — its own ticket; the binding path doesn't need it (store the narrowing delta, reattach a code-built parent).
- **Token vocabulary registry** — a per-app declared set of bind names (`brandUuid`, `recipientUuid`, …) validated at deserialize. Useful once lenses persist; not needed while bindings are supplied at known call sites.
