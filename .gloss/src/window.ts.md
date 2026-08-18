# src/window.ts

## hasWindow

> `export const hasWindow = (rule: WindowFields): boolean =>`

True when a rule carries any windowing selector (filter/orderBy/take/skip).

## conditionOpAndField

> `if ('aggregate' in c) return null;`

not a leaf comparison

## extremalRewrite

> `export const extremalRewrite = (rule: ArrayRule): ArrayRule | null => {`

Extremal-window rewrite for compilation (toPrisma).

When `take: 1` selects the extremal element (max via desc / min via asc) and the
condition compares that same ordered field with a monotonic operator, the windowed
predicate collapses to a plain un-windowed array rule:
  - all + (desc & upper-bound) | (asc & lower-bound)  ⟺  every (max/min is the bound)
  - any + (desc & lower-bound) | (asc & upper-bound)  ⟺  some
`atLeast: 1` is treated as `any`. Returns the de-windowed rule, or null when the
rule is windowed but not extremal-eligible (caller throws "unsupported").

## applyWindow

> `export const applyWindow = <T>(`

Apply the window pipeline to an array: filter → order → skip → take.
`filterFn` evaluates `rule.filter` per item and must be supplied by the caller
when `rule.filter` is set (window.ts stays free of the evaluator).
Direction comes from orderBy `dir`; take/skip are positive offsets.
