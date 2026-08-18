# src/toPrisma/countStep.ts

## buildCountStep

> `export const buildCountStep = (`

Generate a multi-step groupBy plan for count-based relation filtering.

For { field: 'posts', arrayOperator: 'atLeast', count: 3, condition: ... } on User:
  step 0: groupBy Post by authorId where <condition> having _count >= 3
  where:  { id: { in: { __step: 0 } } }

The step is pushed into state.steps and the WHERE clause is returned directly.

> `if (fieldEntry.fromFields.length > 1) {`

Forward relation (current model has FK) — unusual for list relations but handle it

> `const reverseRelation = findReverseRelation(`

Back-relation: FK is on the target model. Find the reverse relation.

## buildHaving

> `const buildHaving = (`

Prisma 6.x having format: field first, then _count nested inside.
e.g. { fanUserUuid: { _count: { gte: 3 } } } — NOT { _count: { _all: { gte: 3 } } }
