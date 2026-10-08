# json-rules — Agent Guide

Standing rulings from Aron. These are architectural law, not suggestions; the git history
(#8, #9, #10, 2.19.x) is the case law behind them.

## The engine is an evaluator. Full stop.

The CORE evaluates ONE rule against data; rules are blind to each other at evaluation.

- **Introspection is fine in principle — at the right layer.** The rejected shape (#9/#10:
  `referencedFieldValues` / `transformFieldValues`, built, reworked, and ripped out the
  same day) was a free-floating grammar walk in the core, keyed by a caller-supplied
  dotted path, with no named consumer. The sanctioned home for "which values does a rule
  use at field X" is the LENS, keyed by its own source declarations (the
  `describeRuleSources(rule, lens)` shape) — the lens owns the vocabulary, so it answers
  questions about it. Callers never pass magic dot-strings.
- **Cross-rule GRAPH concerns stay with the caller.** Reference graphs, reconcile
  ordering, cycle detection, and what to do about an unmappable reference in a clone are
  decisions of the system that authors the rules — the engine/lens can report what a rule
  names; it never orders, freezes, or remaps on anyone's behalf.
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

## Lens rulings (Aron, 2026-10-08)

- **Layers only get darker.** A lens is a stack of filters: each layer can only narrow what the
  layer above exposes, never widen it. Composable, monotonic, stacking is the point of the lens.
- **Each delegate works on its parent's projection**, never the full schema: a layer may only
  mention (pick, omit, turn on, clamp on) what its parent exposes. The base lens is the menu.
- **Postures share one stack.** Reason (the gate: `validateRuleInLens`, `{ lens }` compiles),
  fetch (`toPrisma(true, { lens })` + `toLensSelect` + `projectRows`), read (`readLensValue`), and
  checking what someone can do or see all pass through every layer. Postures can differ in what
  they let through: clamps reason over columns a viewer never gets back.
- **Relations are fields, off by default, turned on through the relation object** — along the
  path (`root.relations.org`) or always-on at the model default (`mapDefaults…models.Org.relations`),
  never through `picks`. Adding a hop's narrowing never hides another relation; hiding is `omits`.
  (Spec and tests for 3.4 must match this; see docs/LENS.md.)
- **A semantic change gets a spec before code.** One paragraph + test cases + the original intent
  (`~/.claude/history.jsonl`, git log) — agreed with Aron first. The relations design was settled
  in May 2026; 3.4's first cut contradicted it because nobody looked.

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
