# src/toPrisma/mapWalk.ts

## walkFieldPath

> `export const walkFieldPath = (field: string, map: FieldMap, rootModel: string): MapWalkResult => {`

Walk a dot-notation field path through the FieldMap.

Returns how to interpret the path:
- 'direct'    – all segments are relations/scalars, use standard nested filter;
                `entry` is the terminal field's map entry
- 'json-path' – a Json scalar was found mid-path; stopIndex segments form the
                Prisma nested key, the rest become the JSON path array
- 'fallback'  – a segment was not found in the map; use existing behavior

> `return { kind: 'json-path', stopIndex: i + 1, jsonPath: parts.slice(i + 1) };`

This segment is a Json field and there are more segments → JSON path

> `return { kind: 'direct', entry: fieldEntry };`

scalar or enum at a terminal position
