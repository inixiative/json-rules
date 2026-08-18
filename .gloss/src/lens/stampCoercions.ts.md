# src/lens/stampCoercions.ts

## COERCIBLE_KINDS

> `const COERCIBLE_KINDS = new Set([`

Kinds check() knows how to coerce — see coerceScalar in src/field.ts.

## resolveField

> `const resolveField = (lens: Lens, scope: Scope, fieldPath: string): ResolvedField | undefined => {`

Resolves a dotted path to its declared entry. Returns undefined when the path descends past
a leaf — including below a Json boundary, where the value's kind is undeclared and therefore
uncoercible, so the rule is left unstamped.

## itemScope

> `const itemScope = (lens: Lens, scope: Scope, fieldPath: string | undefined): Scope | undefined => {`

The model scope a nested array/aggregate condition is evaluated against. Undefined when the
field is not a relation — a Json array's elements are undeclared, so nothing below is stamped.

## stampCondition

> `if ('arrayOperator' in condition || 'aggregate' in condition) {`

Array/aggregate rules: the nested condition/filter evaluate per item, so they
stamp against the relation's target model. The aggregate comparison itself is
numeric by contract and takes no coercion.

## stampCoercions

> `export const stampCoercions = (`

Walk a condition and stamp coerceType onto every field rule from the lens's
field map — the explicit dual of the server's coerceValueForField: the rule
carries its coercion, check() never infers types from values.
