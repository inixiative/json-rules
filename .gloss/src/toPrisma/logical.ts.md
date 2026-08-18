# src/toPrisma/logical.ts

## BuildConditionFn

> `type BuildConditionFn = (`

Forward declaration - provided by condition.ts to avoid circular import

## resolveRelationTargetModel

> `const resolveRelationTargetModel = (`

Walks a relation field path and returns the target model name (for descending
into arrayRule/aggregate sub-conditions). Returns null if the path isn't a
chain of object relations (e.g. terminates in a scalar or hits a bridge).

## conditionTouchesBridge

> `const conditionTouchesBridge = (cond: Condition, options?: BuildOptions): boolean => {`

Does this condition (recursively) hit a bridge field?

Bridge predicates compile to `{}` in toPrisma (the over-fetch sentinel).
In direct AND/OR contexts that's a no-op or harmless over-fetch. But in
`if/then`, the implication is encoded as `NOT(if) OR then` — and Prisma
evaluates `NOT: {}` as match-nothing, which corrupts the implication.

Recurses into arrayRule.condition and aggregate.condition, flipping the
model context to the relation target so nested fields resolve correctly.
A bridge anywhere in the if-clause subtree triggers over-fetch.

> `if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {`

Field-bearing leaves: arrayRule, aggregate, dateRule, field

> `if ('condition' in cond && cond.condition !== undefined) {`

arrayRule/aggregate may carry a nested condition rooted on the relation target.

## buildIfThenElse

> `if (`

if → then is equivalent to: NOT(if) OR then
With else: (NOT(if) OR then) AND (if OR else)
When any sub-clause hits a bridge, the precise compilation breaks:
- bridge in `if`: `NOT({})` becomes match-nothing in Prisma, corrupting the implication.
- bridge in `then` with `else`: `OR[NOT(if), {}]` collapses to match-all, then
AND-ed with `OR[if, else]` silently drops the `then` branch.
- bridge in `else`: symmetric — drops the `else` branch.
Over-fetch the whole expression and let the caller's check() filter against
hydrated cross-source data.

> `const ifClause = buildCondition(cond.if, options, state);`

Build the `if` clause once to avoid pushing duplicate GroupBySteps into state
when the `if` clause contains a count-based array operator (atLeast/atMost/exactly).

> `const thenClause =`

`false` as a then/else branch is a legal deny — buildCondition(false) would
throw, so emit the match-nothing pattern that buildAny uses for empty `any: []`.

> `if (cond.else !== undefined) {`

!== undefined so `else: false` (deny branch) is emitted rather than skipped.

## MATCH_NOTHING

> `const MATCH_NOTHING: PrismaWhere = { AND: [{ id: null }, { id: { not: null } }] };`

Prisma WHERE that matches no rows. Same self-contradiction shape used by buildAny's
empty-array path; relies on the model having an `id` field (true for ~all Prisma models).
