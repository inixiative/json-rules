# json-rules, for its Wardens

json-rules (`@inixiative/json-rules`) is a published, serializable rules engine for TypeScript.
One JSON rule (`Condition`) runs on three rails that must agree: `check()` evaluates it in memory,
`toPrisma()` compiles it to a Prisma query plan (run by `executePrismaPlan` when it has steps), and
`toSql()` compiles it to a PostgreSQL `WHERE` fragment. `toWhereSql` / `toLensWhereSql` write inline
predicates for a caller that names its own columns. The lens is a schema-only view over field maps
that a stack of narrowings can only darken. The standing rulings are in `CLAUDE.md`; a change that
contradicts one goes to Aron first, with a spec.

## Shape of the repository

- One entry, `.` (the root `index.ts`, which names every export), built by tsup to `dist/`. The
  `src/*/index.ts` files are internal barrels.
- `src/check.ts`, `field.ts`, `date.ts`, `dateExpr.ts`, `window.ts`: the in-memory evaluator.
- `src/toPrisma/`: the Prisma planner (field, array, aggregate, date, count and group steps, column
  references, `execute.ts`). `src/toSql/`: the SQL compiler and `whereSql.ts`.
- `src/value/`: value expressions (`evaluateValue`, `validateValue`, `describeValue`).
- `src/lens/`: lenses and narrowings (`policy.ts` decides what a layer shows), the gate, `{ lens }`
  compiles, projection, fetching (`toLensSelect`, `projectRows`) and option sources.
- `src/fieldMap/`: field maps, bridges and the path walk.
- `src/operatorCatalog.ts`: the one table of operators, kinds, value shapes and clock units.
  `src/traverse.ts`: the one structural walk. `src/validate.ts`: `validateRule`.
- Docs: `README.md`, `docs/LENS.md`, `docs/VERBS.md` (enforced by `test/verbs.test.ts`),
  `docs/TIMEZONE.md`, `src/toSql/README.md`.
- Check: `bun run check` (prisma generate for `test/rails`, typecheck, `biome check .`, `bun test`).

## Rules that hold everywhere

- A rail divergence is a bug. Cross-rail changes get a PGlite differential test.
- Negated operators keep NULL rows (on Prisma, where the map declares `isRequired: false`).
- The clock is an input: a relative date needs `now`; there is no wall-clock fallback.
- Own-property lookups only; everything public is plain serializable data.
- One owner per verb (`docs/VERBS.md`); every exported function is named there.
- Lens layers only narrow; only the first narrowing turns relations on, through the relation
  object, never `picks`.

## Words used here

rule, condition, rail, operator catalog, field kind, value source, bind, scope ref, offset, window,
aggregate, value expression, field map, bridge, lens, narrowing, layer, anchor, visit, clamp,
`mapDefaults`, gate, posture, source, option query, engine globals.
