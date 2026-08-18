# src/lens/walk.ts

## isJsonEntry

> `export const isJsonEntry = (entry: FieldMapEntry): boolean =>`

A Json column. It declares no sub-fields, so a dotted sub-path into it is open-ended —
`check`/`toPrisma`/`toSql` resolve the remaining segments against the JSON value at
evaluation time. Lens path resolution stops at this boundary.
