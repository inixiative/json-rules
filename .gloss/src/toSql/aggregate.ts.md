# src/toSql/aggregate.ts

## buildAggregateSubquery

> `const field = quoteFieldAsJsonb(rule.field);`

Use JSONB-preserving field reference — aggregate functions need JSONB input, not text

> ``const extract = `(elem->>'${itemField}')::numeric`;``

JSONB object array

> ``const extract = `elem::numeric`;``

JSONB primitive array
