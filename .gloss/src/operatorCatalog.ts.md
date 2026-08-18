# src/operatorCatalog.ts

## NULLABLE_KINDS

> `export const NULLABLE_KINDS: readonly FieldKind[] = ALL_KINDS;`

Any column can be nullable — nullability is a per-field property, not a per-kind one.
isEmpty/notEmpty ("null or empty string") are therefore valid on every kind; the
SQL/Prisma compilers emit meaningful `IS NULL OR = ''` for any nullable column.
