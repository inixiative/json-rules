# src/toSql/field.ts

## buildFieldRule

> `const rhsVal = rhs.type === 'value' ? rhs.value : undefined;`

Extract both variants up front so TypeScript doesn't need to narrow inside each case

## resolveComparison

> `const resolveComparison = (rule: Rule, state: BuilderState): ResolvedRhs => {`

Resolve the right-hand side of a comparison from a Rule.

- rule.value set        → { type: 'value', value }
- rule.path = '$.field' → { type: 'column', sql: '"alias"."field"' }  (column-to-column)
- rule.path = 'ctx.key' → { type: 'value', value: context[key] }      (external context)
- neither set           → { type: 'value', value: undefined } for no-value operators

> `return { type: 'value', value: undefined };`

No value, no path — valid for no-value operators (isEmpty, notEmpty, exists, notExists)
