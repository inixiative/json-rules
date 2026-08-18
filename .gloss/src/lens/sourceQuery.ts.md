# src/lens/sourceQuery.ts

## SourceSelect

> `export type SourceSelect = { [field: string]: true | { select: SourceSelect } };`

Prisma `select` shape — nested for a grouped source's relation path.

## SourcePrismaQuery

> `distinct?: string[];`

Absent for grouped sources — DISTINCT on the value column alone would collapse
same-value rows across groups; dedup happens in `sourceValuesFromQueryRows`.

> `steps?: PrismaStep[];`

Present only if the composed where used count operators (run via executePrismaQueryPlan).

## SourceSqlQuery

> `export type SourceSqlQuery = { sql: string | null; params: unknown[]; error?: string };`

`sql` is null when the composed where uses a predicate SQL can't express
(e.g. array-condition operators); `error` then carries why. Prisma still
compiles — run that, or fall back to fetch + `check()`.

## SourceQuery

> `path: string;`

dotted projection path (e.g. 'Region' or 'User.region')

> `label?: string;`

Sibling column co-selected as each value's display label (from a SourceSpec's `label`).

> `groupBy?: string[];`

Option-partition axes (from a SourceSpec's `groupBy`, normalized); each axis
column is selected nested in prisma and aliased `__group_i` in sql.

> `composedWhere: Condition;`

node whereClauses ∧ source where(s)

## mergeSelect

> `const mergeSelect = (into: SourceSelect, path: string[]): void => {`

'map.definition.label' → { map: { select: { definition: { select: { label: true } } } } };
axes sharing a prefix merge into one nested select tree.

## compileOne

> `const state: BuilderState = {`

Build the where and the group columns against one state so the axis
paths reuse (and extend) the where's join registry.

## sourceQueries

> `export const sourceQueries = (lensOrNarrowing: Lens | LensNarrowing): SourceQuery[] => {`

Compile a DISTINCT(value) query — Prisma and SQL — per sourced field across
the projected lens. The WHERE is the field's composed eligibility: the model's
own narrowing at that path AND its source where(s). The app runs these (with
its own client) to materialize each field's option set — feed the fetched rows
to `sourceValuesFromQueryRows`.
