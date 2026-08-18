# src/lens/checkRule.ts

## extractEnumLiterals

> `const extractEnumLiterals = (cond: {`

Extracts the leaf "value" from a rule for enum-value validation. Handles
scalar value, array value (for in/notIn), and value via path-ref (skipped —
we can't validate at compile time without context).

> `if (cond.path !== undefined) return null;`

runtime value — skip

## visit

> `terminalAllowedValues =`

Below a Json boundary the value is undeclared, so the column's own allowed set
says nothing about it — only gate a path that ends ON the declared entry.

> `if (isJsonEntry(walked.entry)) nextOpen = true;`

A Json column's elements/members are undeclared — anything nested under it
(condition/filter/orderBy/aggregate.field, `$.` refs) is open-ended.

> `if (walked.entry.kind === 'object' || walked.entry.kind === 'bridge') {`

Walk into the relation target for nested condition descent

> `if ('path' in cond && typeof cond.path === 'string' && cond.path !== '') {`

Gate the RHS `path` ref the same way the LHS `field` is gated — otherwise a rule
can reference outside the lens through its comparison value. `$.`-prefixed paths are
current-element refs (resolve at the current anchor); bare paths are root/context refs
(resolve at the lens anchor). Inside an open scope a `$.` ref points into the JSON
value, so there is nothing to resolve — a root ref is still gated.

> `if ('filter' in cond && cond.filter !== undefined) {`

Gate the window's `filter` (a full Condition over the array elements) and `orderBy`
field refs — both are evaluated against the descended relation target.

> `if (terminalAllowedValues && 'operator' in cond && terminalFieldName) {`

Value-set validation for leaf rules. Fires whenever the field carries an
allowed set — an enum (registry/narrowed) or any other kind with explicit
`values`.

> `if (`

Aggregate sub-field

## checkRuleAgainstLens

> `resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);`

Quickly validate that root visit doesn't have issues either (touches resolveVisit for the side effect, but mainly to ensure policy resolves)
