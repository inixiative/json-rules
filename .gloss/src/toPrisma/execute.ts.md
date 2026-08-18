# src/toPrisma/execute.ts

## executePrismaQueryPlan

> `export const executePrismaQueryPlan = async (`

Execute a Prisma query plan produced by toPrisma().

The plan is a flat list of steps where all but the last are `groupBy` steps
that feed results (via { __step: N } sentinels) into subsequent steps.
The final step is always a `where` step whose resolved WHERE clause is returned.

@param result         - Result from toPrisma()
@param prismaDelegate - Map of camelCase model name → Prisma delegate
                        e.g. { post: prisma.post, user: prisma.user }
@returns The resolved WHERE clause (ready for findMany/count/etc.)

@example
const plan = toPrisma(condition, { map, model: 'User' });
const where = await executePrismaQueryPlan(plan, { post: prisma.post });
await prisma.user.findMany({ where });

> `stepResults.push(`

A related row whose join FK is null belongs to no root entity, so it can
never contribute a membership id. groupBy over a nullable FK still emits a
null group, and Prisma rejects a mixed null+string array in `in`/`notIn`,
so drop nulls here at the gather point. An empty result stays a real `[]`:
`in: []` matches nothing and `notIn: []` matches everything, both correct.

## resolveStepRefs

> `const resolveStepRefs = (obj: unknown, stepResults: unknown[][]): unknown => {`

Recursively replace { __step: N } sentinels with the corresponding step result array.

> `const proto = Object.getPrototypeOf(obj);`

Only plain objects are walked — a compiled leaf like a Date (or Decimal/
Buffer) must pass through untouched; entry-copying it would strip its
prototype and hand Prisma an empty object.
