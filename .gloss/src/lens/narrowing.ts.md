# src/lens/narrowing.ts

## ancestorRemoval

> `const ancestorRemoval = (`

A parent layer's removals bind descendant materialization targets: group keys and
label columns are client-visible option data, so a child source may not reference
what an ancestor removed. The declaring layer itself stays free — visibility ≠
materialization within one layer.

## validateSourceTargetVisibility

> `const ancestorSpecs = [...ancestorChain, ...defaultsFor(mapName, modelName)]`

An ancestor that declared the same target for this field already authorized
materializing those values — re-declaring it is inherited authority, not a
new reference past the ancestor's removals.

> `if (!target) break;`

path resolvability is validated by groupByPathError

## groupByPathError

> `const groupByPathError = (`

A groupBy path descends to-one relations only and must land on a scalar/enum column.

## validateModelNode

> `const reserved = /^__group(_\d+)?$/;`

The sql compile aliases each axis column '__group_i' — a grouped source
selecting a real column of that shape would clobber it in flat rows.

> `const axesKey = JSON.stringify(axes);`

where/sources compose AND-only across layers; divergent axes would
silently re-partition an ancestor's option namespace — fail loud instead.

## validateNarrowing

> `const check = checkRuleAgainstLens(narrowing.root.where, narrowing.parent);`

where filters incoming rows → validate against the parent surface, not this layer's own picks
