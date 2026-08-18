# src/toSql/date.ts

## coerceDateLiteral

> `const coerceDateLiteral = (value: unknown, state: BuilderState): unknown => {`

Same parse-and-anchor seam check() uses (naive strings → midnight in the resolved
zone; instants as-is), emitted as concrete Dates so the SQL param carries the same
instant a re-run check() would compare against.

## resolveDateRhs

> `if (isDateExpr(rule.value) && rule.dateOperator !== DateOperator.within) {`

Point expressions resolve to a concrete Date at compile time (operator-aware
implied edges). `within` is handled separately in the switch.

> `return {`

Arrays (between pairs, dayIn day names) are handled per-operator in the switch.
