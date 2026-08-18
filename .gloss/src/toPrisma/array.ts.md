# src/toPrisma/array.ts

## BuildConditionFn

> `type BuildConditionFn = (`

Forward declaration - provided by condition.ts to avoid circular import

## buildArrayRule

> `if (`

Count operators generate a full WHERE clause (step ref) — skip the nested-filter wrapper

## resolveRelationTarget

> `const resolveRelationTarget = (field: string, map: FieldMap, rootModel: string): string | null => {`

Walk a relation field path and return the target model name, so inner conditions
resolve against the right model (enables JSON-path and bridge detection inside
some/every/none). Returns null if the path isn't a chain of object relations.

## buildArrayLeafFilter

> `const childOptions = childOptionsFor(rule, options);`

Inner condition runs against the relation target model, not the parent.
Without this, JSON-path and bridge detection misfire inside some/every/none.
