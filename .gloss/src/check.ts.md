# src/check.ts

## checkIfThenElse

> `return condition.else !== undefined ? check(condition.else, data, opts) : true;`

`false` is a legal else value (deny branch); use !== undefined so it's
evaluated rather than skipped by truthiness.
