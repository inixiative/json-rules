# json-rules — Agent Guide

Standing rulings from Aron. These are architectural law, not suggestions; the git history
(#8, #9, #10, 2.19.x) is the case law behind them.

## The engine is an evaluator. Full stop.

It evaluates ONE rule against data. Rules are blind to each other by design.

- **No rule-introspection APIs.** "Which values does this tree reference," "which rules
  mention X," remap/re-point tools — all REJECTED (see #9/#10: `referencedFieldValues` /
  `transformFieldValues` were built, reworked, and ripped out the same day). Cross-rule
  concerns — reference graphs, reconcile ordering, cycle detection, clone id-remapping —
  belong to the CALLER, which authors the rules and knows where its reference arms live.
- **The lens owns vocabulary questions.** If a caller-side need is really "which values
  does a rule use at a field the lens declares as a source," the sanctioned home is a
  lens API keyed by the lens's own source declarations — never a free function taking a
  caller-supplied dotted path.
- **No new API without its first consumer named in the PR.** A plausible story is not a
  consumer. Speculative surface gets polished instead of challenged, and that is how the
  messes happen.

## One structural walk

`src/traverse.ts` (`visitCondition` / `mapCondition`, internal) lists the grammar's child
slots — `all`/`any`, `if`/`then`/`else`, `condition` + windowing `filter` — exactly once.
Never hand-roll a condition-tree descent; a walk written elsewhere goes blind the day the
grammar grows a node type (that exact bug shipped: bindings were blind to `filter` until
2.19.3). Evaluators/compilers (`check`, `toSql`, `toPrisma`, `validate`) keep their own
recursion — their descent IS their semantics — and are guarded by differential tests
(check vs executed SQL via PGlite), not structural sharing.

## Semantics rulings

- **The clock is an input.** Relative date expressions require `now` in options; there is
  no wall-clock fallback, deliberately — one evaluation pass = one instant on every rail.
- **Negation keeps NULL rows** (2.19.0–2.19.2), on all rails: negated operators AND the
  negative-flavored date operators (`notBetween`, `dayNotIn`) match a NULL column; positive
  operators don't. `check()`, `toSql`, and `toPrisma` must always agree — a rail
  divergence is a bug even when each rail is individually defensible.
- **Own-property lookups only.** `Object.hasOwn(map, key)`, never `key in map` — a bind
  or mapping key named `toString` must not resolve from `Object.prototype`.
- **Everything serializable.** Public API inputs and outputs are plain JSON data — no
  Sets, no callbacks, no functions in results.

## Working style

The primitives here are sufficient far more often than they look — they are novel, not
incomplete. Before writing machinery around one (a wrapper, a custom walk, a magic
dot-string constant, an "improved" variant), find the primitive-native spelling or extend
the primitive itself. If your change needs a new walker or registry, you have missed the
elegant path — stop and reread this file.

Verification: `bun run check` (typecheck + biome + tests). Cross-rail changes get a
PGlite differential test (see `test/nullSemantics.test.ts`, `test/date.negatedNull.test.ts`
for the pattern). Releases go through the @inixiative/config train; push to main, no PRs
for maintainers (external contributions come as PRs).
