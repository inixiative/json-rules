# src/toPrisma/date.ts

## coerceDateLiteral

> `const coerceDateLiteral = (value: unknown, config: DateConfig): unknown => {`

Literal/path date values compile through the same parse-and-anchor seam check()
uses (naive strings → midnight in the resolved zone; instants as-is), emitted as
concrete Dates — a raw 'YYYY-MM-DD' in a Prisma where is rejected by Prisma and
would carry different zone semantics than check().

## resolveDateValue

> `const resolveDateValue = (rule: DateRule, options?: BuildOptions): unknown => {`

Resolve the date value for a DateRule.
- rule.value → use literal
- rule.path starting with '$.' → throw (no column-to-column in Prisma WHERE)
- rule.path (context ref) → look up from options.context

## buildDateLeafFilter

> `const point = (): unknown =>`

Point operators: resolve a date expression (operator-aware implied edges) to a
concrete Date at compile time, else fall back to literal/path resolution.
