# src/validate.ts

## validateDateRule

> `if (isDateExpr(rule.value)) {`

Structured date expressions (v2.6): ago/ahead, this/last/next, start/end.

> `pushIssue(`

`within` only accepts an expression range (period or rolling), not a literal pair.

> `if (!parseDateValue(rule.value, 'UTC').isValid()) {`

A date-like value must actually parse — a string that survives validation but
fails the compilers/check() would persist clean and then fail at evaluation.

## validateRelativeUnits

> `const validateRelativeUnits = (units: unknown, path: string, context: ValidationContext): void => {`

--- v2.6 date-expression validation ---

## validateWindow

> `const eligible =`

toPrisma supports the extremal (take:1, aligned, unfiltered) rewrite to every/some.
