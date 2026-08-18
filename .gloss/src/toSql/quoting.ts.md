# src/toSql/quoting.ts

## escapeLikePattern

> `export const escapeLikePattern = (value: string): string => {`

Escape a value for use in a LIKE pattern.
Escapes \, %, and _ which are special characters in PostgreSQL LIKE.

## quoteField

> `export const quoteField = (field: string): string => {`

Quote a field name as a SQL identifier, handling JSON paths.
Uses pg's escapeIdentifier for proper SQL injection prevention.

Examples:
  "name" → "name"
  "data.theme" → "data"->>'theme'
  "settings.display.mode" → "settings"->'display'->>'mode'

## quoteQualifiedField

> `export const quoteQualifiedField = (field: string, alias: string): string => {`

Quote a field (with possible JSON sub-path) qualified with a table alias.

Examples:
  quoteQualifiedField('name', 't0')           → "t0"."name"
  quoteQualifiedField('data.theme', 't0')      → "t0"."data"->>'theme'
  quoteQualifiedField('data.a.b', 't0')        → "t0"."data"->'a'->>'b'

## quoteFieldAsJsonb

> `export const quoteFieldAsJsonb = (field: string): string => {`

Like quoteField but keeps the leaf as JSONB (uses -> instead of ->> at the end).
Required when the result must be a JSONB value, e.g. as input to jsonb_array_elements().

Examples:
  "scores"           → "scores"
  "settings.scores"  → "settings"->'scores'
