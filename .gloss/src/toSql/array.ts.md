# src/toSql/array.ts

## buildArrayRule

> `const lengthFn = isNative`

Different length functions for JSONB vs native PostgreSQL arrays

> `` ? `array_length(${field}, 1)` ``

Native: TEXT[], INT[], etc.

> ``: `jsonb_array_length(${field})`;``

JSONB arrays

> ``return `(${field} IS NULL OR ${lengthFn} IS NULL)`;``

Native arrays: NULL or empty (array_length returns NULL for empty)
