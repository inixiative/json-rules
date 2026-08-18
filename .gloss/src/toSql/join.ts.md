# src/toSql/join.ts

## resolveFieldSql

> `export const resolveFieldSql = (field: string, state: BuilderState): string => {`

Resolve a dot-notation field to a fully-qualified SQL expression,
generating LEFT JOINs for any relation traversals found in the map.

Falls back to quoteField() when map/model/alias are not set or a
segment is not found in the map.

Mutates state.joins, state.joinCounter, and state.joinRegistry.

> `if (!modelEntry) return quoteField(field);`

fallback

> `if (!fieldEntry) return quoteField(field);`

fallback

> ``const registryKey = `${currentAlias}.${parts[i]}`;``

Traverse relation: generate (or reuse) a JOIN

> `if (!joinClause) return quoteField(field);`

fallback: can't determine FK

> `const remaining = parts.slice(i);`

scalar or enum — remaining parts are either the column itself or JSON sub-path

> `return quoteField(field);`

Reached end after only traversing relations (field is the relation itself)

## buildJoinClause

> `const buildJoinClause = (`

Build a LEFT JOIN clause string for a relation field traversal.
Returns null when the FK cannot be determined.

> `onCondition = fieldEntry.fromFields`

Forward relation: current model has FK (composite FK supported via multi-condition AND)

> `const reverse = findReverseRelation(map, targetModel, currentModel, fieldEntry.relationName);`

Back-relation: FK is on the target model — find the reverse relation.
Pass relationName so multiple relations between the same two models are disambiguated.
