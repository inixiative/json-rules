# src/toSql/types.ts

## BuilderState

> `map?: FieldMap;`

Map-aware state (only populated when map+model are provided)

> `joinRegistry?: Map<string, string>;`

Registry: "parentAlias.fieldName" → assigned alias (prevents duplicate JOINs)
