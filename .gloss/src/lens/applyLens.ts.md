# src/lens/applyLens.ts

## wrapWithWheres

> `const wrapWithWheres = (rule: Condition, wheres: Condition[]): Condition => {`

Composes a user rule with the lens's narrowing where-clauses, injecting each
`where` at its proper anchor in the rule tree (not blindly AND-ing at root).
Anchoring rules (2.2.0):
- root.where → AND at root (path-specific at lens anchor)
- mapDefaults[M].models[X].where → injected wherever rule visits X in map M
- root.relations[R]...relations[R].where → injected when rule descends through R
Operator-specific injection inside an arrayRule:
- any/none/atLeast/atMost/exactly/aggregate.condition: AND with original condition
- all: filter-first via the array rule's window `filter` (drops out-of-scope rows before
order/take/skip and before the all-check) — never a per-row negate implication

## prefixConditionFields

> `export const prefixConditionFields = (cond: Condition, prefix: string): Condition => {`

Re-roots a related-model `where` grant so its field refs resolve from the current
anchor through the relation path (e.g. a User grant `tenantId` reached via `author`
becomes `author.tenantId`). Fails closed on shapes that can't be re-rooted
unambiguously — a `path` ref (root/current-element semantics don't survive re-rooting)
or a nested array/aggregate condition (row-scoped to a different anchor) — rather than
silently emitting a wrong or unenforced grant.

## collectHopWheres

> `const collectHopWheres = (policy: Policy, hops: RelationHop[]): Condition[] => {`

Gathers the (re-rooted) wheres for each traversed relation hop so they can be AND-ed
with the rule at the current anchor. To-many hops have no scalar path to AND against —
their grant must be row-scoped via an arrayOperator condition — so reaching one here
(a to-many with a grant but no condition anchor) fails closed rather than dropping it.

## injectIntoArrayCondition

> `const injectIntoArrayCondition = (`

Inject `where` into an arrayRule's inner condition. For any/none/atLeast/atMost/exactly, AND
injection preserves the operator's meaning. (`all` is filter-first — handled in rewriteRule by
injecting the grant into the window `filter`, not the condition.)

## rewriteRule

> `const rewriteRule = (`

Walks the user rule recursively, looking for points where a model anchor
matches a `where` declared in the policy. At each such anchor, injects the
`where` with the appropriate semantic for the surrounding rule shape.

> `if ('field' in rule && typeof rule.field === 'string' && rule.field !== '') {`

arrayRule, aggregate, dateRule, plain Rule — all have a `field`.

> `let curMap = mapName;`

Walk the field path, recording EVERY relation hop it traverses (including mid-path
to-one hops), so each hop's model-anchored `where` grant can be enforced — not only
when the FINAL segment is a relation.

> `if (entry.kind !== 'object' && entry.kind !== 'bridge') break;`

scalar/Json — stop descent

> `if ('condition' in rule && rule.condition !== undefined && descended) {`

Final relation with an inner condition (arrayRule / aggregate): recurse into the
condition at the descended model context and inject that relation's wheres with the
row-scoped semantic. Mid-path hops before it are enforced via re-rooting.

> `allGrants.push(whereClause);`

Filter-first: an `all` grant drops out-of-scope rows via the window `filter`, which
`check` applies before order/take/skip AND before the all-check. A per-row `negate`
implication is unsound under a window and under partial (missing-field) semantics.

> `inner = { all: [whereClause, inner] };`

aggregate condition: AND injection

> `return wrapWithWheres(rule, collectHopWheres(policy, relationHops));`

No inner-condition injection: enforce every traversed relation's `where` by
re-rooting it under the relation path and AND-ing it with the rule (to-one and
mid-path hops). collectHopWheres fails closed on a to-many hop with a grant.

## applyLens

> `const rewritten = rewriteRule(rule, policy, policy.lens.mapName, policy.lens.model, []);`

First rewrite the rule, injecting where clauses at their anchors.

> `return wrapWithWheres(rewritten, rootEffect.whereClauses);`

Then wrap with root-anchored where clauses (root.where +
mapDefaults[lens.mapName].models[lens.model].where).
