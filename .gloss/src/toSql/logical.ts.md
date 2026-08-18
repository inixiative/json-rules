# src/toSql/logical.ts

## BuildConditionFn

> `type BuildConditionFn = (condition: Condition, state: BuilderState) => string;`

Forward declaration - will be provided by condition.ts

## pathHitsBridge

> `const pathHitsBridge = (field: string, map: FieldMap, model: string): boolean => {`

Walks a field path through the FieldMap; returns true if any segment hits a bridge.
Bridge predicates compile to 'TRUE' in toSql — fine as a no-op in AND, but inside
`NOT(...)` they corrupt the implication semantics.

## resolveRelationTargetModel

> `const resolveRelationTargetModel = (`

Walks a relation field path and returns the target model (or null if the path
isn't a chain of object relations). Used to flip model context when descending
into arrayRule.condition / aggregate.condition.

## conditionTouchesBridge

> `if ('condition' in cond && cond.condition !== undefined) {`

Recurse into arrayRule.condition / aggregate.condition with model context
flipped to the relation target so nested fields resolve correctly.

## buildIfThenElse

> `if (`

When any sub-clause hits a bridge, the precise compilation breaks: bridge
predicates compile to 'TRUE', and NOT(TRUE) OR X = X collapses the implication
(or in the with-else form, silently drops the then/else branch). Over-fetch
the whole expression and let the caller's check() filter precisely.

> `if (cond.else !== undefined) {`

if → then is equivalent to: NOT(if) OR then
With else: (NOT(if) OR then) AND (if OR else)
