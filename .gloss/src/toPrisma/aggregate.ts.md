# src/toPrisma/aggregate.ts

## BuildConditionFn

> `type BuildConditionFn = (`

Forward declaration - provided by condition.ts to avoid circular import

## walkAggregateFieldPath

> `const walkAggregateFieldPath = (`

Walk a dot-notation field path through the FieldMap to find the terminal list relation.

Returns the segments traversed, the final list relation entry, and the model it lives on.
E.g. for 'department.employees' on User:
  - segments: ['department', 'employees']
  - intermediate: User → Department (singular)
  - terminal: Department.employees → Employee (list)

> `if (!fieldEntry.isList) {`

Terminal segment — must be a list relation

> `if (fieldEntry.isList) {`

Intermediate segment — must be a singular relation

## buildAggregateStep

> `const innerWhere = rule.condition`

Build inner WHERE from condition (if present)

> `const aggKey = rule.aggregate.mode === 'sum' ? '_sum' : '_avg';`

Prisma 6.x having format: field first, then aggregate operator nested inside.

> `if (intermediateRelations.length > 0) {`

If there are intermediate relations, nest the filter through them

> `const leafFilter = { [pkOnTerminal]: { in: stepRef } };`

The step ref gives us IDs of the model that owns the terminal list relation.
We need to filter back through intermediate relations to the root model.
