# src/fieldMap/buildBridgeDictionary.ts

## BridgeDictionary

> `string,`

map name

> `string,`

model name

> `Record<string, Record<string, Row | Row[]>>`

on field → identifier → row(s)

## buildBridgeDictionary

> `const valid = rawData[bKey].filter((row) => row[b.on] !== null && row[b.on] !== undefined);`

Filter null/undefined `on` values — lodash groupBy would otherwise stringify
them into 'null'/'undefined' keys, causing spurious joins when looking up
rows whose own join field is null.
