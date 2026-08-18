# src/bindings.ts

## requiredBindings

> `export const requiredBindings = (condition: Condition): Set<string> => {`

Names of every `{ bind }` token reachable in a condition tree. The flat-set
shorthand a caller validates a bindings map against (`keys(bindings) ⊇ requiredBindings`).

## resolveBindings

> `export const resolveBindings = (`

Replace each `{ bind }` token the map covers with its `{ value }`, leaving uncovered
tokens in place (partial / progressive resolution — `requiredBindings` shrinks). A node
may carry both its own value-bind and a nested condition (aggregate/array), so both are
handled. Does not mutate the input.

> `const bound = bindings[bind as string];`

A supplied binding (key present) resolves to its value; undefined → null so
the substituted condition stays clean serializable JSON. Absent keys are
left as tokens (partial resolution), never coerced.
