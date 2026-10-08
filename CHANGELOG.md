# Changelog

## 3.4.0 — relations are fields, off by default; `context` removed

Breaking, with no compatibility path (no users).

### Relations

Before, the gate resolved visibility per model: with `root: { picks: ['id', 'org'] }` a rule on
`org.parent.name` passed because Org's fields were visible — a lens that showed one relation handed
a rule the whole map, back and forth. The fetch opened such a relation "shallow", and 3.2's `rules`
option opened whatever re-checked rules read. Now relations are fields, off by default, and every
posture — the gate, `walkLensPath`, `readLensValue`, the projections, the sources, the fetch —
reads one exposure from `src/lens/policy.ts`.

- **Off until turned on.** A bare lens reads its anchor's columns only. The first narrowing over
  the base lens turns a relation on through the relation object — along the path
  (`root.relations.org`) or at the model default (`mapDefaults…models.Org.relations.users`, which
  `ModelDefaultNarrowing` now takes, nested relation objects included). A relation that is off is
  `hidden`: `walkLensPath` / `readLensValue` say so, the gate refuses with `not_in_lens`, `{ lens }`
  compiles throw, and `projectLens` / `toLensSelect` / `projectRows` leave it out.
- **Later layers narrow.** exposed₁ = layer 1 turns it on ∧ ¬ layer 1 hides it; exposedₖ =
  exposedₖ₋₁ ∧ ¬ layer k hides it. A later layer hides a relation with `omits`, or restates one its
  parent shows to narrow that hop (a restatement hides nothing else); naming one its parent doesn't
  show is `not_visible`.
- **`picks` names columns only.** A relation in `picks` is `wrong_kind`; `omits` may name a
  relation beside `picks`.
- **The model defaults grow a tree.** From the anchor and every path spelled under
  `root.relations`, model-default turn-ons are followed breadth-first, each model at most once — at
  its nearest reach, ties to the earlier parent and then field order — never one already on the
  spelled path. Anything else is spelled. Every posture walks the same tree (exact agreement, at
  most spelled nodes × models visits).
- **Grants.** The first narrowing's `where`s and source eligibility `where`s may read any relation
  on the schema; a later layer's only what its parent shows (a delegate can't probe what it can't
  see) — `validateNarrowing` reports it and every runtime posture throws rather than apply it. A
  bare value `path` reads the root row, so only `root.where` may hold one; in a relation grant, a
  model default or a source's eligibility `where` it is `invalid_value_source` and a runtime throw.
  A grant reads its own row: a scope ref that climbs out of it (`$$.` at its top) is
  `scope_out_of_bounds` and a runtime throw.
  One check decides a later layer's grant — the gate over its parent's surface, relations and
  columns — and `validateNarrowing` and every posture make it at the same visits: the ones the
  grant applies at, including those a layer-1 grant or source crosses off the shown tree. A grant
  narrowRule can't re-root under a to-one hop is refused by `validateNarrowing` and by
  `validateRuleInLens` (with narrowRule's message), as the compile would.
  `validateNarrowing` runs the postures the runtime runs — the projection by path and by model,
  `lensVisit` at every shown path, the source plans, the fetch select, and a rule reaching each
  shown visit narrowed — and reports each refusal they raise as an issue, so `ok` holds exactly
  when no posture refuses. Nothing compiles there, so an unbound lens validates as its bound
  runtime runs. Every refusal a posture raises is a `LensRefusal` — narrowRule's, the source
  planner's (a label or axis hop it can't guard, an empty `sources: {}`), the fetch select's — and
  the validators report it as an issue and never throw on a well-formed lens or rule; the runtime
  postures throw it.
- **The fetch's root.** A root that shows no column is selected by its `id`, hidden or not (a
  viewer's projection drops it), since Prisma can't select nothing.
- **`lensVisit(lens, relationPath)`** (new; first consumer: rules-builder 0.30): one visit as
  `projectLens` by path gives it, resolved on demand without enumerating; `null` when the path
  isn't shown. `projectLens` by path keeps a map's declared option labels and groups.
- **Sources.** A dotted `label` / `groupBy` crosses only relations shown at each visit it is
  projected (else `invalid_source`, and the projection drops it); a source keyed on a relation, or
  a bare `label` naming one, is `wrong_kind`. A source `where` is narrowed under the whole lens as
  `narrowRule` narrows a rule — each relation it crosses carries its grants, inside an array
  condition and on every hop and terminal relation of a dotted path — so an option never comes
  through a row the lens hides (before, a grant on a relation read inside the source's array
  condition, or on the relation a path ends on, was not applied). A source's label and axes read
  what every layer but the one declaring them shows, the chain kept whole (before, dropping the
  declaring layer from the chain lost the first narrowing's turn-ons when it was the one).
  `toSourceQueries`' SQL selects from the model's `dbName`, as its joins do. A source whose query
  holds a window toPrisma can't compile — its own `where`'s or a grant carried into it — is refused
  by its shape (a `LensRefusal`, which `validateNarrowing` reports), by both materializers.
  The source pipeline is one set on every rail: `toLensSelect` fetches what each projected source
  reads (value, label, axes, and its condition's columns and relations — the inverse relations
  that carry the grants above included), `projectRows(…, { keepGrantColumns: true })` keeps them,
  and `materializeSources` checks the condition the option query compiles (the visit's own grants
  included), so fetched rows offer what the database does. A path source is linked down its path
  through each declared inverse even where no grant sits above, so its query offers only rows
  reached down the path. `toSourceQueries(lens, options?)` takes the clock. A source where across
  a bridge has no query (`prisma: null`, `sql.error`) rather than one folded to `TRUE`. Every rail
  labels a value by its least label and orders ties by value. What toPrisma can't compile in a
  to-many relation's grant (the fetch select) or a source's condition is read by `validateRule`
  (toPrisma, with the map) — which now also reports a case-insensitive list comparison and a
  count or aggregate over a relation that can't carry a group step — and refused as a
  `LensRefusal`. A relation node re-roots under a to-one hop by its field (`users any …` on an Org
  is `org.users any …` on its User), so a path going to-one then to-many ("users in my org")
  carries its link and grants; one whose inner ref climbs to the re-rooted row is refused, never
  an empty list. The fetch reads a source below its visit only — the fetched tree is the path's
  link, so `materializeSources` walks it, each level's grants met, and checks the source's
  condition at its visit. `materializeSources` throws on rows missing a key its sources or the
  grants on their paths read (a viewer's projection), and materializes a source across a bridge
  (a bridged pointer included) from caller-supplied rows holding the far side; `toSourceQueries`
  routes a bridged where, label or axis to it (`prisma: null`). A compile of a lens's own grant or
  source that fails on a literal is a `LensRefusal`; a missing clock or unbound bind stays the caller's
  usage error. `validateRule` (toPrisma) also reports a case-insensitive comparison on
  Json, a list literal holding null, and an element condition over an array column, and accepts a
  case-insensitive set of members on a list column. Errors say whose input went wrong:
  `UsageError` (a missing or invalid `now`, an invalid time zone, a bind never bound) and
  `LensRefusal` (with a `code`) are exported, each with its `name`. A rail that can't hold the
  lens's grants on a rule refuses it (`LensRefusal`, code `unsupported_target`) rather than throw a
  plain Error. `materializeSources` requires every key a read walks — through relations and list
  elements to the column — and each relation as one row or a list, as the map declares it. A
  grant a source's path can't carry down (no inverse declared) is a `LensRefusal`; a path across a
  bridge is routed to caller rows.
- **Fetch.** `toLensSelect` / `projectRows` open exactly what is turned on, plus the columns grants
  read. The `rules` option and the shallow fetch are removed. A to-many relation's grant the select
  can't carry as its `where` — a count or an aggregate (a counting step), or a window toPrisma has
  no form for — is refused before anything compiles. A relation that shows no column is
  selected by its key alone (the join key, else `id`, hidden or not), never another column; a model
  with no key is not fetched, and presence on it can't be re-checked from fetched rows.

### `context` removed

`check(rule, data, { context })` (since the first commit) read a bare `path` from a second object, and 3.0 made
the compilers read it from `options.context` — a second caller-value channel beside binds, which
`narrowRule` read as a column. It is gone from `CheckOptions`, `ToPrismaOptions` and
`ToSqlOptions`.

- **Caller values are binds:** `{ bind }`, `check(…, { bindings })`, `bindRule` before compiling.
  `timeZone` is a string or a `{ bind }`.
- **A bare `path` is a root-row column on every rail,** gated and narrowed like a field:
  `check()` reads the root row; `toSql` compiles a column (equality, ordered); `toPrisma` compiles a
  Prisma field reference (`{ __field }`, resolved by `executePrismaPlan` to
  `prisma.<model>.fields.<column>`) between two columns of the same model at the same visit (a bare
  path at the root, `$.` in a relation filter), of exactly the same type, with `equals` /
  `notEquals` / `lessThan(Equals)` / `greaterThan(Equals)` and no offset — NULL rows as
  `IS [NOT] DISTINCT FROM`. Anything else throws, and `validateRule(rule, { target: 'toPrisma',
  map, model })` / `describeRule` report it first. A substring, pattern or set operator against a
  column throws on both compilers (save a list column's membership on SQL), and `validateRule` /
  `describeRule` say so. A negated comparison (`if`, `all`) compiles to its
  complement with NULL arms. An enum column compares only with an enum column of its own type, by
  equality (natively on SQL); ordered and enum-to-text comparisons are refused, and a list column compares with no column. Inside a counting step (a count or relation aggregate condition) a
  column comparison has no Prisma form and throws.
- **The plan's references are unforgeable.** Each step records where its own `{ __step }` /
  `{ __field }` references sit (`refs`), and `executePrismaPlan` resolves only those locations; a
  rule value holding a `__step` / `__field` key is refused at compile.

Migration: turn on every relation you cross with `relations` (path or mapDefaults) on the first
narrowing; remove relation names from `picks`; drop `rules` from `toLensSelect` / `projectRows`;
pass caller values as binds, not `context`.

## 3.3.1 — browser bundles, own-property reads, CJS types

- **No top-level `node:module` import.** `toPrisma`'s Prisma `AnyNull` lookup imported
  `createRequire` from `node:module` at the top of the bundle, which broke every browser bundle
  that reaches json-rules (Vite: "Module 'module' has been externalized for browser
  compatibility"). The loader now comes lazily from `process.getBuiltinModule('module')` (Node
  ≥20.16, Bun), with the CJS build's `require` as before; on the server a Json null check still
  uses the installed `@prisma/client`'s `AnyNull`. `engineGlobals.set('prismaOptions.anyNull', …)`
  still overrides it.
- **Path reads are own-property only.** A path step read inherited non-function values (a class
  getter), contradicting the own-property ruling and `readLensValue`'s contract. It now reads own
  properties only — an array's index and `length` and a string's `length` included — so `check()`
  and `readLensValue` agree inside Json. A getter on a class instance (in a row or in `context`)
  reads `undefined`; pass plain data.
- **CJS consumers get CJS types.** `exports["."].require` now resolves `dist/index.d.cts`
  (`node16` from CJS was "Masquerading as ESM").
- **Docs:** the `{ lens }` compile example no longer claims it equals
  `toPrisma(narrowRule(rule, narrowing), …)` — on the compile rails a bare value `path` is read
  as the caller's `context`.
- **Tooling:** `prepare` installs lefthook only inside a git checkout.

## 3.3.0 — read a value through a lens

- **`readLensValue(lens, row, path, options?)`**: one value off a row as the lens shows it. The
  path is gated by the walk `validateRuleInLens` uses (hidden / missing / past a column refused);
  each row on the way, the root included, is checked against its visit's grants, so a row a grant
  hides reads `null`; only own properties are read, into Json too; a path ending on a relation or
  crossing a list is refused. First consumer: template's email interpolation, which read token
  values with lodash `get` over rows `projectRows` had cut.

## 3.2.0 — compile and fetch under a lens

Additive. Each function replaces code template wrote around the lens.

- **`getLensRoot(lensOrNarrowing): Lens`**: the base lens of a narrowing chain (a lens is its own),
  throwing on a cyclic chain. It is the internal `getRoot`, now public. Replaces template's
  `rootLens` and its repeated `'parent' in lens ? rootLens(lens) : lens`.
- **`toPrisma` / `toSql` take `{ lens }`**: the rule is gated by the lens (`validateRuleInLens`; a
  rule it refuses throws, so `{ lens }` can't compile a read of a hidden column; a bare value
  `path` is the caller's `context` on these rails, not a column, and isn't resolved through it) and compiles
  narrowed by it (`narrowRule`), against the base lens's maps, `mapName` and `model`. Passing `lens` with `map` / `mapName` /
  `model` throws. Replaces the `toPrisma(narrowRule(rule, lens), { map: root, mapName, model })`
  call sites in template (`compileSegmentWhere`, `resolveUsers`, `validateRuleForLens`).
- **`bindLens` keeps its input's type**: `bindLens<T extends Lens | LensNarrowing>(lens: T, …): T`,
  so template's `bindLens(…) as LensNarrowing` casts go.
- **`toLensSelect(lensOrNarrowing, options?)`**: Prisma `findMany` select args for the rows a lens
  shows. It selects each projected path's visible columns, the relations its declared paths open
  (a visible relation off them brings its visible columns), and every column a `where` on the way
  reads. A to-many relation carries its visit's grants, compiled, as its `where`, so related rows
  come pre-narrowed, unless a grant reads that list (a grant reads it whole, as the database does).
  `rules` opens each relation the given rules read past the declared paths as a declared one, so a
  re-check of those rules has every row and column it reads, grants applied. A to-one relation can't take a `where` in Prisma; `projectRows` drops the
  rows its grant hides. A relation that shows no column is fetched whole; bridges are skipped. A
  relation grant that needs a counting step throws. `options` carries the clock (and context) for
  the grants' compile. Replaces template's `includeFromLens`.
- **`projectRows(lensOrNarrowing, rows, { keepGrantColumns?, rules?, ...checkOptions })`**: rows cut to
  what a lens shows, recursively. Hidden columns and relations are removed, and every row a
  visit's `where` hides is gone: a root or list row is dropped, a to-one row is null.
  `keepGrantColumns` keeps the exact columns those `where`s read, and a hidden to-one row, or a hidden row of a list a grant reads, as those
  columns alone instead of `null`, so a later `check(narrowRule(rule, lens), row)` re-tests the
  grants as the database does (a negation or `notExists` through it doesn't admit it). That output
  carries hidden values — for re-checks, never for a viewer. It takes `toLensSelect`'s `rules`, for
  the rules it will be re-checked with. Replaces template's `prune`; with
  `toLensSelect` and `toPrisma(true, { lens })`, `fetchLens` becomes three calls.

- **`exists` / `notExists` on a required column compile on Prisma.** They read `{ not: null }` /
  `{ equals: null }`, which Prisma rejects on a required column; a required column is null only
  where the row it sits on is missing, so they now ask that (`{ is: {} }` on the path above, or
  always / never at the root).

- **A null read from a source, on Prisma:** `equals` / `notEquals` against an unbound optional bind
  or a path reading null on a required column, an aggregate threshold with no operand (it matches
  nothing, as `check()` says), and a negated date range missing an end now agree with `check()`.
- **SQL reads a non-array Json value as an empty array for `empty` / `notEmpty`**, as it already
  did for an aggregate (it read it as non-empty).
- `check()`'s failure text prints a RegExp pattern as written (it printed `{}`).
- **A narrowing is what has a `parent`.** A narrowing carrying a stray `model` (e.g. spread from a
  row) was read as the base lens, dropping every layer above it; one carrying `model` / `maps` now
  throws.
- **A pointer escapes only the layer that declares it.** Layers after it carried nothing into its
  options, so a tenant layer added after a platform pointer (scoping by a root `where`) left other
  tenants' rows in the picker. Every layer but the pointing one now carries its grants. A later
  layer scoping by a root `where` reaches the pointer only down the path: it then offers linked
  rows only, and nothing across a bridge. Scope tenancy through `mapDefaults` to keep unlinked rows.
- **`{ lens }` reads a bare value `path` as context in the narrowing too.** `narrowRule` read it as
  a row path and wrapped a relation's grant around it, so a context key named like a relation
  (`org.id`) changed what a rule matched under the lens.
- **`resolvePolicy` tells a base lens from a narrowing as `isLens` does** (by its own `parent`).
- **`composeLens` refuses a stored record carrying its own `parent`.** The record's `parent`
  replaced the composed chain, so a forged layer dropped every layer above it (a tenancy grant
  with it); a layer composes only through `parents`.
- **A source `label` / `groupBy` is exempt only for the layer that set the value in force.** A
  layer could restore a label on a column an ancestor hides after a layer between replaced it
  (`name` → `age` → `name`); restating the value in force still keeps it.

## 3.1.1 — a pointer never widens what a parent layer gave

- **Security:** a child layer could turn a parent's path source into `from: 'mapDefaults'` and drop
  the grants the parent carried down the path — its tenancy included, so another tenant's rows
  showed. A pointer now drops the path's carried grants only from the layer that points on; the
  layers before it still carry theirs, so a child's pointer can only narrow what it was given.
- A pointer folds a child's narrowing of the relations below its path (a dotted label through a
  narrowed `org` is guarded, as a path source's is).
- An undeclared pointer throws when projected even where a layer hides its field, as
  `validateNarrowing` reports it.
- A relation's existence compiles to `{ is: {} }` (present) / `NOT { is: {} }` (missing), required
  or not: no `null` filter for Prisma to reject on a required relation, and no requiredness to know
  — a hand-written map without `isRequired` gets it right too. Replaces 3.0.1's shortcut.

## 3.1.0 — a path source can offer its model's own source

A source declared down a relation path offers the rows reachable from there (3.0 carries every
grant above it). `{ from: 'mapDefaults' }` on a path source offers the model's own source instead:
`mapDefaults[map].models[model].sources[field]` for the map and model the path reaches — every row
the lens lets the model show, linked or not, under that source's tenancy, label and axes, its own
`where` and child layers only narrowing it. It resolves where it sits, so it names nothing; one
whose model declares no source fails `validateNarrowing` (`invalid_source`) and throws when
projected or compiled. Across a bridge it compiles against the far map alone. `ProjectedVisit`
gains `sourceFrom`; `materializeSources` refuses a pointer (query it instead). First consumer:
template's Tag and Segment references, which a rule names before anything links them.

## 3.0.1

- **`exists` / `notExists` on a required to-one relation compile on Prisma.** A required relation
  is there whenever its row is, so `toPrisma` read it as `{ isNot: null }` / `{ is: null }`, which
  Prisma rejects on a required relation's filter. It now compiles through the optional hops above
  it alone: `exists` matches wherever none is missing, `notExists` only where one is. This is what
  a source's carried ancestor grant (`{ field: <inverse>, operator: 'exists' }`) emits through a
  required inverse.

## 3.0.0 — one verb, one name, one implementation

A consolidation release. Every operation has one public name and one implementation;
`docs/VERBS.md` is the catalog and `test/verbs.test.ts` keeps it that way. `src/` grew by about
1,250 lines (12%) over 2.27.0. The growth is the rails agreeing: typed Json comparisons in SQL,
enums, case-insensitivity, RE2 patterns and the refusals each rail now states where it can't
express a rule.

### Breaking: renamed and reshaped API

| 2.x | 3.0 |
| --- | --- |
| `applyLens(rule, lens)` | `narrowRule(rule, lens)` |
| `checkRuleAgainstLens(rule, lens)` → `{ ok, violations: { path, reason }[] }` | `validateRuleInLens(rule, lens)` → `{ ok, errors: { path, message, code }[] }` |
| `stampCoercions(rule, lens)` | `coerceRule(rule, lens)` |
| `resolveBindings(rule, bindings)` | `bindRule(rule, bindings)` |
| `resolveLensBindings(lens, bindings)` | `bindLens(lens, bindings)` |
| `bindingNames(rule)` → `Set` | `listBindings(rule)` → sorted `string[]` |
| `requiredBindings(rule)` → `Set` | `listBindings(rule, { required: true })` → sorted `string[]` |
| `lensRequiredBindings(lens)` → `Set` | `listLensBindings(lens)` → sorted `string[]` |
| `projectByPath(lens, opts)` → `Map<path, ProjectedVisit>` | `projectLens(lens, opts)` → `Record<path, ProjectedVisit>` |
| `exposedSurface(lens, opts)` | `projectLens(lens, { ...opts, by: 'model' })` |
| `ruleSourceValues(lens, rule)` | `describeRuleSources(rule, lens)` |
| `sourceQueries(lens)` | `toSourceQueries(lens)` |
| `sourceValuesFromRows(lens, rows, opts)` | `materializeSources(lens, rows, opts)` |
| `sourceValuesFromQueryRows(query, rows, opts)` | `materializeSourceQuery(query, rows, opts)` |
| `executePrismaQueryPlan(plan, delegates)` | `executePrismaPlan(plan, delegates)` |
| `resolveLensPath(...)` | `walkLensPath(...)` |
| `resolveScopeRef(ref, scopes)` | `readScopeRef(ref, scopes)` |
| `validateNarrowing(n)` — throws | `validateNarrowing(n)` → `{ ok, errors }`; `assertValidNarrowing(n)` throws |
| `validateFieldMapSet(set)` — throws | `validateFieldMaps(set)` → `{ ok, errors }`; `assertValidFieldMaps(set)` throws |
| `validateFieldMap(map, name)` | `assertValidFieldMaps({ maps: { [name]: map } })` |
| `buildBridgeDictionary(set, rawData)` | `indexBridges(set, rawData)` |
| `RuleLensViolation`, `RuleLensCheck` | `ValidationIssue`, `ValidationResult` (`{ path, message, code }`) |
| `describeRule(...).violations: string[]` | `describeRule(...).errors: ValidationIssue[]` (the lens gate's issues) |
| `getValueShape(operator)` | `getValueShape(operator, family)` — `family` is `'field' \| 'date' \| 'array'` (`between` is in two) |
| `getAggregateOperators(target)` | `getAggregateOperators()` — every target compiles them all |
| `getWindowSupport`, `WindowSupport`, `WINDOW_SELECTOR`, `WindowRuleType` | `validateRule(rule, { target })` reports an unsupported window |
| `isOperatorSupportedForTarget`, `isAggregateSingleOperator`, `isAggregateRangeOperator` | `getOperatorsForKind(kind, target)`, `getAggregateOperators()`, `validateRule(rule, { target })` |
| `isCalendarUnit`, `isRelativeUnit`, `RelativeUnit` | `validateRule` reports an unknown or fractional unit |
| `FIELD_OPERATOR_CATALOG`, `DATE_OPERATOR_CATALOG`, `ARRAY_OPERATOR_CATALOG`, `CatalogEntry`, `ArrayCatalogEntry` | `getOperatorsForKind`, `getArrayOperators`, `getAggregateOperators`, `getValueShape` |
| `BuildOptions`, `SqlResult` | `ToPrismaOptions`, `ToSqlResult` — beside `ToSqlOptions`, all named for their verb; both options extend `CompileOptions`, whose `context` is a `Row` |
| `ProjectOptions` | `ProjectLensOptions` |
| `CreateLensInput` | `Lens` — `createLens` takes and returns one |
| `ProjectedVisit.modelName`, `LensPathHop.modelName` | `model`, as on `Lens`, `SourceQuery` and the compile options |
| `SourceValue` (a `sources` entry), `RuleSourceValues` | `SourceEntry`, `RuleSourceDescription` — `SourceValues` (materialized options) keeps its name |
| `FieldMap`, `FieldMapEntry`, `SourceOption` from the `toPrisma` / `toSql` entry points | one export each from the package root, with `ModelEntry` |
| `readBinding`, `validateBindNames`, `resolveCaseInsensitive`, `resolveFuzzy`, `supportsQueryMode`, `fuzzyContains`, `maxFuzzyDistance`, the catalog's internal operator / kind / unit sets | no longer exported |

Every validator returns `{ ok, errors: { path, message, code }[] }` and has an `assert*`
form that throws. Lens issues carry codes (`not_in_lens`, `operator_kind_mismatch`,
`invalid_value`, `value_not_allowed`, …).

`validateNarrowing` reports a code per problem (`not_in_lens`, `not_visible`,
`conflicting_selection`, `wrong_kind`, `value_not_allowed`, `invalid_source`, `invalid_binding`, and
the lens gate's own codes for a `where`). `toSql` takes a FieldMapSet with `mapName`, as `toPrisma`
does. Newly exported types: `Row`, `CheckData`, `OperatorFamily`, `ToSqlOptions`, `CompileOptions`,
`ModelEntry`, `SourceSelect`, `ValidateRuleOptions`, `ListBindingsOptions`,
`MaterializeSourceQueryOptions`. `assertValidRule` labels its error
`validateRule:` like the other asserts.

`getAggregateOperators()` takes no target: every target compiles every aggregate comparison
(`toPrisma` gained `notBetween`), and the `unsupported_prisma_aggregate_operator` code is gone.

### A lens has three forms: composed, stored, projected

`StoredLens` is a lens as a database holds it: one record per layer, each with its `id` and the
ids of every layer it composes with, the base lens first (stored as itself, no parents).
`storeLens(lens, ids)` writes a composed lens out; `composeLens(id, records)` resolves the records
back into the composed lens every evaluator takes, validating each layer and failing closed on a
missing, misplaced or stale record. Projections stay output only.

### Json null checks on Prisma use `Prisma.AnyNull`

A Json column holds a DB NULL or a JSON `null`, and a path inside it can be absent; `check()`
reads all three as null. Prisma matches them together only with its `AnyNull` instance, which
`toPrisma` takes from your installed `@prisma/client` (a new optional peer dependency). Set
`engineGlobals.set('prismaOptions.anyNull', …)` only to use a different client's.

### Security

- **A value ref must read a column.** A `path` (or offset / amount ref) ending on a relation
  passed the lens gate, and `check()` printed the whole related row — hidden columns included —
  in its error text. The gate rejects it and `toSql` refuses it.
- **A to-many relation takes array operators only.** `posts contains { … }` (or `equals`, `in`) passed
  the gate and compared whole child rows in `check()` — hidden columns included; the gate, `toSql`
  and `toPrisma` now refuse a field or date rule on a to-many relation.
- **A to-one relation as a field only exists or not.** Ordered and range comparisons on one
  passed the gate and `toSql` compiled them against the relation's key, which a narrowing can
  hide.
- **Option lists honor every ancestor's grant.** A source declared on a relation path read its
  model's rows with only its own visit's `where`; the grants above it (the root `where`, a
  parent relation's) now carry down through the inverse relation, and a grant no inverse can
  carry offers nothing.
- **The lens gate refuses a node of two kinds** (`operator` and `dateOperator`, `arrayOperator`
  and `aggregate`, logical and leaf), as `validateRule` does — one shape detector serves both.
- **Patterns run on RE2** (`re2js`, a runtime dependency), in time linear in the input: no pattern
  can stall `check()` (`.*.*.*.*!` and `(a+)+` took seconds on short text). What RE2 can't run — a
  backreference, a lookaround, a flag other than `i` — is refused on every rail; `validateRule`
  reports `unsupported_pattern`. A RegExp's `i` flag compiles to `~*` / `!~*`.

- **A layer can't revive what a layer above it hid.** A source `label` or `groupBy` axis reads
  only what every layer but its earliest declaration shows. A grandchild re-declaring an ancestor's
  label on a column a layer in between omitted shipped that column's values as option labels;
  `projectLens` and `validateNarrowing` now drop and report it through one check.
- **A value ref ending on a bridge relation** is refused, as one on a local relation is.
- **A missing related row is not a hidden one.** `narrowRule` AND-ed a to-one relation's grant
  onto every rule through it, so `author notExists` could never hold and a negation through the
  hop lost its NULL rows. A row outside the grant still fails the rule; a relation that isn't
  there reads as absent.
- A sourced field named after an `Object.prototype` key no longer inherits a label or axes.
- A hidden `groupBy` axis drops from the projected fields as well as from `sourceGroupBys`.
- A `$`-scoped field through a granted to-one hop reads a missing relation as absent too.

### Breaking: the rails agree

`check()`, `toSql` on Postgres, and `toPrisma` on Prisma 7 now agree on every rule they all
compile. `test/rails.agreement.test.ts` runs all three against one database: PGlite for SQL,
and real Prisma through PGlite's socket server with a FieldMap that `@inixiative/prisma-map`
reads off the generated client.

- **An absent path reads as NULL in `check()`**, as a column does in SQL: a missing key or a
  path through an absent to-one relation. `org.name equals null` matches a user with no org;
  `notIn [null]` no longer does. `toPrisma` adds the relation's `{ is: null }` arm to
  `equals null`.
- **A NULL or absent array is empty** in `check()` (it threw "must be an array"), and an
  aggregate skips NULL items, as SQL's `SUM` / `AVG` and Prisma's `_sum` / `_avg` do (it threw).
- **A string or set operator with nothing to compare against** (a context path or optional bind
  that reads nothing) matches no row, and its negation keeps the NULL fields only — as ordered
  comparisons already did. `toSql` bound the string `'null'` (so `contains` matched "nullable")
  and `toPrisma` emitted `contains: null`, which Prisma rejects.
- **A to-many relation inside a plain field path is an error** on both compilers
  (`posts.title equals …`): `toSql` matched any child and `toPrisma` emitted an invalid filter.
  Compare its rows with an array rule on `posts`.
- **Prisma relation aggregates keep parents with no children** (their sum and average are 0).
- **A relation `all` fails a child whose condition reads NULL**, as in `check()`: Prisma's
  `every` passed it. `all` compiles to `none` over the exact complement of its condition.
- **A bridged condition over-fetches** in `none`, `all`, `atMost` and `exactly` (a matching child
  can make them false); `none: {}` under-fetched. A bridged `isEmpty` no longer emits
  `OR: [{}, {}]`, which Prisma reads as match-nothing.
- **A to-one relation is a field that exists or not**: `org exists`, `org.parent notExists`,
  `isEmpty` / `notEmpty`, and `equals` / `notEquals` null compile on both compilers (they emitted
  a missing column and an invalid filter).
- **Empty is `null`, `''`, or `[]`** on every rail: a list or a Json array with no elements is
  empty, as `isEmpty` / `notEmpty` and the array operators read it.
- **Fuzzy containment is refused by the compilers whether the rule or the engine-global default
  sets it** (a global default made `check()` match fuzzily while both compilers compiled an exact
  match).
- **`notStartsWith` / `notEndsWith`** complete the negated operators: every operator now has an
  exact complement, which Prisma uses for an implication's antecedent and a relation `all`
  (an implication or `all` over `startsWith` / `endsWith` threw on Prisma).
- **`caseInsensitive` applies to `in` / `notIn`** on every rail (all three ignored it).
- **Values compare as JSON does**: by value (a list or an object deeply — `check()` compared them
  by reference) and never across types. `"3"` never equals `3`, and an ordered comparison or a
  range only holds between two numbers, two strings or two dates (`check()` coerced `"3" > 1`).
  `toSql` compares a Json value as `jsonb` against the operand's JSON (it compared `->>` text, so
  `3` equalled `"3"` and `true` equalled `"true"`); string operators read strings only.
- **`contains` on a list or a Json array is membership**, and `caseInsensitive` applies to it like
  to any text: `check()` lowers every string on both sides, a list's members included (it lowered
  the operand only); SQL compares lowered members. Prisma's list filters have no case-insensitive
  mode, so a case-insensitive list comparison is refused there. On Prisma, `contains` on
  Json is `string_contains` OR `array_contains`; `notContains` and `notBetween` on Json have no
  Prisma form (its Json filters can't test a value's type) and throw.
- **An enum compares exactly, as its column does.** String, pattern and ordered operators don't
  apply to an enum (the catalog said so; the compilers emitted `LIKE` on an enum, or a filter
  Prisma rejects) and are refused. A case-insensitive equality or membership — or one naming a
  value the enum doesn't declare, which the database refuses to read — compiles to the declared
  values it matches (`IN (…)`, plus the NULL arm for a negation); the map lists them (prisma-map
  does).
- **A string literal on a number or Boolean column without `coerceType` is refused** by the
  compilers (`toSql` cast it, `toPrisma` handed it to Prisma, `check()` compared it strictly);
  stamp `coerceType` to compare it.
- **`in` / `notIn` with a scalar, and an unknown period unit, throw on every rail** (they compiled
  to an empty set and to a millisecond).
- **`toSql` array `empty` on a Json value holding JSON null** no longer fails
  (`jsonb_array_length` of a scalar); array and field emptiness share one form.
- **A string of digits is epoch milliseconds** on the date rail too, as a `coerceType: DateTime`
  field rule read it (`'1700000000000'` parsed as a year).
- **`indexBridges` reads own properties only**: a row keyed `constructor` was a spurious duplicate,
  and a map named after an `Object.prototype` member wrote onto it.
- **Dates in Json read as `check()` reads them on SQL** — digits as epoch milliseconds, a zoned
  string as its instant, a zoneless one as wall time in the evaluation's zone (it read in the
  database session's zone). Prisma compares Json as text, so a date rule on Json is refused there.
- **A Json value compares against an operand known at compile time**, an offset included (an
  offset made SQL compare `->>` text); a per-row operand on Json is refused on SQL.
- **Refused where a database would answer differently:** an ordered comparison or range against a
  boolean, list or object (Prisma panicked); the complement of an ordered comparison on Json on
  Prisma (it drops the other types); membership of an object or list in a Json array on Prisma
  (`array_contains` matches partially — SQL now compares members exactly); `startsWith` /
  `endsWith` on a list; a number or boolean literal on a String column without `coerceType`;
  an aggregate mode other than `sum` / `avg` on Prisma.
- **`toPrisma` escapes `%` and `_`** in `contains` / `startsWith` / `endsWith` (and Json `string_*`):
  Prisma matches with LIKE and passed them through as wildcards.
- **A scalar list `exists` / `notEquals`** compile on Prisma (`{ not: null }` is not a list
  filter).
- **A narrowed `all` compiles on Prisma.** `narrowRule` puts an `all` grant in the window `filter`;
  `toPrisma` folds a filter-only window into the rule (`all` through the exact complement of its
  condition, the rest as `filter AND condition`). Both compilers threw on it.
- **A window sorts NULLs last** in both directions: `orderBy views desc, take 1` is the largest
  value, as "latest" reads (a NULL sorted first). The extremal `all` rewrite on Prisma is exact
  under it: the array is empty, or some element has a value and none with one breaks the bound.
- **A `Date` field value compares as DateTime** in `check()` without a `coerceType`, as the
  compilers read a DateTime column: `createdAt greaterThan '2026-10-05T00:00:00Z'` compared a
  `Date` with a string.
- **An implication with a NULL antecedent** holds on every rail (`NOT(if)` was NULL in SQL).

Prisma filters by column kind, from the map (a stamped `coerceType` is the fallback):

- **Json**: `contains` / `startsWith` / `endsWith` compile to `string_contains` / … ; `in` /
  `notIn` to one `equals` / `not` per value; negations on a path keep absent paths.
- **Scalar lists**: `contains` compiles to `has`; `empty` / `notEmpty` to `isEmpty` (a NULL list
  is empty). Element conditions over a list or a Json array have no Prisma form and throw.
- **`caseInsensitive`** applies to text only; `mode: 'insensitive'` on an Int column was a
  Prisma error, and `toSql` no longer emits `LOWER()` on a non-text column.

On the SQL rail:

- **A whole Json column's JSON `null` is NULL** (`NULLIF(col, 'null'::jsonb)`): `meta exists` no
  longer matches it.
- **A Json path compared against a number compares numerically**; it compared `->>` text, so
  `'3' > '25'`.
- **A scalar list `contains`** compiles to `array_position(col, $n) IS NOT NULL` (it emitted
  `LIKE` on an array).
- **No session-zone dependence.** A `Date` parameter binds as its ISO-8601 instant (drivers
  serialize a `Date` in the host zone, which a `timestamp` column then reads as wall time). A
  date compared against a per-row operand, or a weekday, reads a DateTime column through its
  epoch, which a `timestamp` column holding UTC wall time and a `timestamptz` share; it was cast
  `::timestamptz` through the session zone.

- **A case-insensitive equality matches only its value.** Prisma compiles one to ILIKE and passed
  `%` and `_` through as wildcards; String columns escape them, and on Json, which Prisma matches
  as JSON text where an escape is itself escaped, a value with `%`, `_` or a backslash is refused.
- **`contains` on Json:** a string holds only a string (SQL matched `"a1b" contains 1`); an array
  holds a member, case-insensitively under the flag (SQL lowers each element; Prisma, whose
  `array_contains` can't, refuses). A number or boolean compiles to `array_contains` alone.
- **Patterns mean the same on Postgres.** `toSql` translates RE2's dialect: `.` stops at a
  newline, word boundaries and `\d` `\w` `\s` and POSIX classes stay ASCII, `\z` becomes `\Z`,
  `\x41` and octal escapes are characters (not Postgres's longer hex or a backreference), a `-`
  after a class is literal, a zero-led repeat count is literal text, and `\Q…\E` and named groups
  translate. A Unicode class, a flag group or a repeat past 255 is refused, and
  `validateRule(…, { target: 'toSql' })` reports it.
- **A list `in` / `notIn` a set of lists** compiles as the equalities it means (both compilers
  threw); Prisma refuses a list holding `null`, which its list filters can't take.
- **A case-insensitive Json comparison with a list operand** lowers the list's strings on SQL, as
  `check()` does, and is refused on Prisma; a Json value holding a quote or a control character is
  refused there too (Prisma's JSON text escapes them).
- **Operands read per row on SQL:** a list `contains` one; a column compared with a Json value
  read per row, a set or a pattern read per row, and a date rule on (or read from) a number or
  boolean column are refused with a clear error rather than a raw Postgres one. A padded epoch
  string in Json reads as `check()` reads it.
- **Clear refusals, never raw database errors:** a date rule reads only a DateTime, text or Json
  path (an enum, a list or a whole Json column is refused); a list `contains` a member read per
  row only when the member is text and the list holds strings; a string operator on a non-text
  column, an offset against text, a range end that doesn't order and a quantified anchor in a
  pattern are refused on SQL.
- **A date rule on a non-DateTime column** (String, a number) is refused on Prisma, which sent it
  a `Date`; a Json epoch with a fraction reads on SQL.
- **An unknown aggregate mode** throws on every rail; `toSql` computed it as AVG, and `check()`
  returned a failure a negation could turn true.

Three differences remain, all outside the rules' control:

- Case-insensitive comparison follows each engine's case mapping: JavaScript's `toLowerCase` and
  Postgres's `LOWER` under the database collation can differ on letters like `İ`.
- An array or aggregate rule on a Json value that isn't an array is a data error: `check()`
  throws on it, and SQL, which can't raise per row, reads it as an empty array.
- Ordered string comparisons (`lessThan`, `between` on text) follow each engine's order:
  `check()` compares UTF-16 code units, Postgres the column's collation.

### Fixed

- **`narrowRule` (was `applyLens`) skipped grants on a relation node with no `condition`**
  — emptiness, an aggregate, a filter-only node — and never rewrote its `filter`, so grants on
  relations the filter reached were not injected. Grants now scope its rows through `filter`.
- **`projectLens` (was `projectByPath`) projected a relation a child layer hid.**
- **Own-property reads everywhere.** Field-map, narrowing and map-default lookups, and every
  row / context / item / `orderBy` path read (lodash `get` is gone): a name on
  `Object.prototype` reads as absent. `coerceType: 'toString'` fails validation.
- **One map walk for every compiler leaf.** `toSql` array and aggregate rules join dotted
  fields and qualify their columns like field rules; `toPrisma` date and array rules are
  map-aware (Json sub-paths, bridges). A path past a non-Json column is an error on both
  compilers; `toSql` read it as a JSON path and `toPrisma` dropped the tail.
- **The bridge check in an implication sees `filter`.**
- **One default zone, never the host's.** With no `timeZone`, periods and `now` read in UTC
  (they read in the host zone). The test suite runs under `TZ=Pacific/Kiritimati`.
- **A `coerceType: DateTime` field rule anchors a zoneless string in the evaluation zone**, as a
  date rule does (it read UTC).
- **Weekday lists** read any value source, and an unknown name throws on every rail
  (`check()` failed to match).
- **`describeRuleSources`** marks a leaf dynamic when an offset or a read amount moves its value.
- `validateRule` treats an empty `orderBy` as no window, like the compilers.
- **`describeRule`'s `supportedTargets`** are the targets `validateRule` passes (a bridge still
  limits it to `check`); its own copy of those checks missed an aggregate's `condition` on SQL.
- **`validateNarrowing` reads inheritance the way the lens resolves it.** An enum value an
  inherited narrowing hides is `not_visible` (the not-picked case was `invalid_source`), and a
  relation an ancestor narrows counts as picked for a child's picks / omits, as `projectLens`
  already read it.

### Output changes

- `toPrisma` leaves a single-arm OR unwrapped (`{ a: … }`, not `{ OR: [{ a: … }] }`).
- `toPrisma` leaves a single-arm AND unwrapped too.
- `toPrisma` writes `notContains` as `{ NOT: { f: { contains } } }` for every column kind, and a
  relation `all` as `{ none: <complement> }`.
- `toSql` binds `Date` parameters as ISO strings.
- A `toSql` array or aggregate column is alias-qualified when a map is given.

## 2.27.0 — one value-source type in every slot; `offset`; amounts and `timeZone` read any source

**First consumer:** Zealot platform alerts (userevidence/Zealot-Monorepo#2656). The incident
lifecycle is a `@inixiative/transitions` map, and its auto-resolve guard reads its window off
the incident's own rule — self-contained, no caller-supplied bind:

```ts
{ field: 'lastBreachedAt', dateOperator: 'before',
  value: { ago: { seconds: { path: '$.platformAlertRule.autoResolveAfterSeconds' } } } }
```

Design: `tickets/FEAT-006-value-sources-offset.md` (ZLT-5217).

- **One type, one reader.** `ValueSourceOf<T>` — `{ value } | { path } | { bind }` (with
  `bindOptional`) — is the shape of every slot that reads a value: a rule's comparison value,
  an `offset`, each unit amount, the evaluation's `timeZone`. The loose rule types share
  `ValueSourceFields<T>`; `PathRef` and the bind-only `TimeZoneConfig` are gone. Each rail reads
  it in one place (`check()`: `readValueSource`; the compilers' bind is a compile error unless
  optional), and a leaf's value-source slots are listed once, so `resolveBindings`,
  `bindingNames` and `requiredBindings` reach every one. Date and aggregate rules
  with a `bind` threw on `check()` while they compiled after `resolveBindings`; they now
  resolve with the field rule's key-presence contract (`Missing binding for "<name>"` unless
  `bindOptional`; a supplied `undefined` is `null`). A bound date value can be a date, a date
  expression (resolved against `now`) or a `[from, to]` pair.
- **`offset`** moves the comparison value, and is a value source of its own with the
  comparison value's contract: `{ value }`, `{ path }` or `{ bind }` (with `bindOptional`). A
  field rule's offset reads a number (a golf handicap: `grossScore <= $.par + $.handicap`); a
  date rule's reads `{ ago }` / `{ ahead }`, anchored on the comparison value. It shifts the
  comparison operators and both ends of `between` / `notBetween`, on any comparison value — a
  literal plus an offset names what the grammar can't alone (`start of this month + 4 days`).
  `resolveBindings`, `bindingNames` and `requiredBindings` cover offset binds.
- **Unit amounts are value sources.** Every `RelativeUnits` amount (in a `value` expression or a
  date offset) is a number or a value source — `{ path }` (`$.` from the row, bare from
  context), `{ bind }` or `{ value }`.
- **`timeZone` is a value source.** `string | { value } | { path } | { bind }`: read from context
  or bindings, once per evaluation (a `$.` path throws), on every rail. The compilers used to
  ignore a `{ bind }` zone and compile in UTC.
- **Rails.** `toSql` compiles a `$.` amount to `col ± make_interval(…)` / `col + n` and
  resolves a context amount; `toPrisma` resolves a context amount and throws on a `$.` one.
  Both compilers now refuse an unresolved required date bind, as they already did for fields.
- **Validation and lens.** `validateRule` accepts `bind` as a value source (it rejected every
  bind-only rule with `missing_value_source`), and gates offsets (`unsupported_offset_operator`,
  `invalid_offset`) and amount refs per target like `path`; a date offset read per row is
  check-only.
  `checkRuleAgainstLens` gates offset and magnitude refs through the lens, requires them to
  read a number, and requires an offset to fit the field's kind; `describeRule` and
  `applyLens` treat them as `path` refs.

**Behavior changes.**

- A date `path` that reads null (or nothing) fails closed. It used to compare against the
  current time (`parseDateValue(undefined)` is `dayjs()`), so `check()` matched rows SQL
  rejected. A null bind, offset or magnitude fails closed too; a negation keeps null fields.
- Relative units apply in Postgres interval order — months (years, quarters, months), then days
  (weeks, days), then time — instead of key order, so `check()` and `toSql` agree at month ends.
- A date `path` that reads a date expression now evaluates it instead of ignoring it.
- Relative shifts (`{ ago }` / `{ ahead }`, offsets) move on the wall clock of the evaluation's
  `timeZone` — UTC when none is set, never the host's zone — as Postgres moves a timestamp by an
  interval `AT TIME ZONE`: a day is 23 hours on a spring-forward day.
- Calendar units (years, quarters, months, weeks, days) are whole numbers: a fractional literal
  is an `invalid_relative_magnitude` and throws at evaluation (dayjs rounded it before).
- A `timeZone: { bind }` with no binding throws `Missing binding`, as every bind does; it fell
  back to UTC before. Mark it `bindOptional` for the UTC fallback. The compilers throw on an
  unresolved zone bind instead of silently using UTC.
- `validateRule` validates every value source alike: `ambiguous_value_source`,
  `missing_value_source`, and `invalid_value_source` (a non-string `path`/`bind`, or
  `bindOptional` without `bind`) — for an offset too, which reported `invalid_offset` for these.
- The missing-source error reads `No value, path or bind specified`.
- A `$.` value path (comparison value, offset or amount) reads the row the way a `field` does on
  `toSql`: relation hops join and a Json tail is a JSON path. It compiled to one quoted column
  (`"t0"."rule.windowSeconds"`) before.
- Nothing to compare against matches nothing on every rail, and a negation keeps null fields: an
  ordered comparison or a range that reads nothing, or a range missing an end. `check()` threw on
  a field range with a null end; `toPrisma` emitted `{ lt: undefined }` (every row) or
  `{ lt: null }` (rejected).
- A context path that reads nothing reads `null`, the is-null sentinel for `equals` /
  `notEquals`, as a supplied-but-undefined binding already did.
- Aggregate rules read `bind` on both compilers; `toPrisma` also reads a context `path`.
- `toSql` lowercases only string comparisons under `caseInsensitive` (`LOWER(int)` failed).
- Operator, kind and relative-unit sets are defined once in `operatorCatalog.ts`.
- The SQL rail treats a DateTime column as `timestamptz`. A plain `timestamp` column (Prisma's
  default) is read as UTC through the session zone, as Prisma writes it. `dayIn` / `dayNotIn`
  assumed `timestamp` and were off on `timestamptz`; a shift read per row assumed `timestamptz`
  and was off across DST on `timestamp`.

## 2.26.0 — `checkRuleAgainstLens` gates operator, value and array-operator fit

**Stricter validation.** A rule that passed the lens gate before can fail it now: one that
cannot evaluate: the compiled Prisma filter throws, Postgres rejects it, or `check()` cannot
iterate it. Literals are JSON values only. The gate reads the field kind from the resolved
`FieldMapEntry` (or the rule's `coerceType`) and the operator's catalog `kinds`, the data
the builder's operator picker already uses.

- **Operator ⇄ field kind.** A field or date operator whose catalog `kinds` exclude the
  field's kind is a violation:
  `operator 'contains' does not apply to DateTime field 'createdAt' (applies to: String)`.
  Date operators (`before`, `within`, `dayIn`, …) now fail on a non-DateTime column.
- **Value ⇄ field kind.** A literal operand that does not fit is a violation:
  `value 123 does not fit String field 'name' (expected a string)`. For `in`, `notIn`,
  `between` and `notBetween`, each element is checked.
  - String and enum columns take a string.
  - Int and BigInt take a safe integer (BigInt compares as Int, below). A `bigint` is not JSON
    and is rejected.
  - Float takes a finite number. Decimal takes a finite number or a numeric string
    (`'100.10'`), the lossless spelling a rule builder keeps.
  - An operator that compares one value (`equals`, `lessThan`, `contains`, …) rejects a list
    literal: `operator 'equals' compares one value, but String field 'name' was given a list`.
  - Boolean takes a boolean.
  - DateTime takes what `check()`'s DateTime coercion turns into an instant: day-only
    strings, ISO strings with or without a zone, epoch-ms numbers or digit strings, and
    `Date`.
  - `null`, `path` refs, `bind` tokens and regex patterns are not checked.
  - With a `coerceType` (a `stampCoercions` stamp, or an override) the literal fits as
    written or after `check()`'s own coercion, which the compilers now apply too (below), so
    a stamped `'5'` passes on an Int column and an unstamped one does not. `toPrisma` /
    `toSql` refuse an override at compile time (below).
  - The violation reads `value 'abc' does not fit field 'name' coerced to Int (expected an integer)`.
- **arrayOperator ⇄ cardinality.** An array operator on a field that is not a list is a
  violation, and its `condition` / `filter` are not walked:
  `arrayOperator 'any' needs a list, but 'account' is a to-one relation — a single related record; address its fields directly (e.g. 'account.<field>')`. The same applies
  to `… is a single String value` for a scalar. These count as lists: a to-many relation,
  a `oneToMany` bridge, a scalar list and a Json column. An object relation with no
  `isList` is treated as to-one.
- **Not gated:**
  - Json columns and Json sub-paths
  - fields inside an open scope
  - scalar lists (for field operators)
  - relation terminals (`exists` on a relation)
  - scalar types outside `FieldKind`
  - aggregate thresholds

**BigInt compares as Int, on every rail.** Prisma returns a BigInt column as a JS `bigint`,
and `check()` failed every comparison against one: `5n === 5` is false and a `bigint` was not
orderable, so an in-memory rule over Prisma rows never matched a BigInt column. `check()` now
turns a `bigint` (row value, literal, binding, path ref, list element) into a number; a stamped
BigInt digit string coerces like an Int literal, in `check()` and both compilers. The gate
holds BigInt to Int's fit: a safe integer, or a stamped digit string. A BigInt past ±2^53
cannot be held exactly by a number, so it throws (`RangeError: BigInt … is outside the safe
integer range`) rather than compare wrong; the gate reports it as a misfit.

**`toPrisma` / `toSql`: a stamped literal compiles the way `check()` coerces it.** With a
`coerceType`, Int, BigInt, Float, Boolean and String literals are coerced exactly as `check()`
does — the rule builder's text inputs emit `'5'`, which Prisma rejects on an Int column. Decimal
literals are emitted as written: Prisma and Postgres take the numeric string losslessly. Json sub-paths and scalar lists declare no kind and compile as before.

**`toPrisma` / `toSql`: DateTime field-operator literals compile to instants.** A field operator
(`equals`, `lessThan`, `in`, `between`, …) on a DateTime column used to pass its literal
through as written. Prisma accepts only a `Date` or a zoned ISO-8601 instant, so
`createdAt gt '2026-09-01'`, a zoneless ISO string and an epoch-ms number all threw at query
time ("Expected ISO-8601 DateTime"); Postgres cast a bare string in the session's zone
while `check()` anchors it in UTC. Both compilers now run the literal — and a context
`path` value — through `check()`'s own DateTime coercion, element-wise for lists, `null`
kept. `toPrisma` emits a `Date`; `toSql` emits the zoned ISO string, because a pg driver
serializes a `Date` param in the host's zone, which a `timestamp` (no time zone) column drops. The column is DateTime per the field map, or per a stamped
`coerceType: 'DateTime'` when no map is passed. An unparseable literal throws at compile
time: `Invalid date value for DateTime field 'createdAt': not-a-date`.

**`toPrisma` / `toSql`: a `coerceType` that overrides the column's kind throws.** The
compiled query compares the column as stored; neither compiler can cast it, so the override
used to be ignored silently and the query compared the raw literal against the column. Now:
`coerceType 'Int' overrides String field 'name', but toPrisma compares the column as stored —
evaluate it in memory with check(), or drop the override.` Only a compared literal is
refused: `exists`, `isEmpty`, `notEmpty`, `notExists` and `equals null` compile as before, as
do a stamp equal to the column's kind, a column the map does not type (Json, Json sub-paths,
scalar lists) and an unmapped field.

## 2.25.0 — `resolveLensPath`: one path through the lens, verified hop by hop

- **`resolveLensPath(lens, path)`** resolves a dotted path hop by hop and returns where it lands:
  `resolved` (with the hops, the terminal `FieldMapEntry` and a Json remainder), `hidden` (the
  model has the column, the narrowing does not expose it at that visit), `missing` (the map does
  not have it) or `pastScalar` — each failure with its segment index. It is the walk
  `checkRuleAgainstLens` gates a rule's `field` with, now exported for consumers that resolve
  paths of their own (template tokens, loop bindings, presence guards) so nobody rebuilds lens
  reachability beside the lens. The gate's internal walk delegates to it.

## 2.24.0 — `source.label` accepts a dotted to-one path

- A `SourceSpec.label` may name a dotted to-one path, like `groupBy`.

## 2.23.0 — Scope refs: `$$.` reaches the enclosing array element

- **`$$.`, `$$$.`, …** on `path` count scopes up the array-operator stack — `$.` is the
  current element, `$$.` the element of the enclosing array operator, and so on to the
  root row. Logical combinators add no level; array and aggregate rules (their `condition`
  and windowing `filter`) each add one. A bare `path` is still the root context.
- **`field` takes the same prefix.** A bare `field` is still the current element;
  `field: '$$.maxQty'` reads the enclosing element, so two ancestors compare directly
  (`field: '$$.a', path: '$$$.b'`). Array and aggregate rules accept it too — the ancestor's
  collection is iterated.
- **Out of bounds is an error on every rail.** `check()` throws naming the ref and the
  reachable depth; `validateRule` reports `scope_out_of_bounds` at the leaf (`.field` /
  `.path`, both when both overreach); `checkRuleAgainstLens` reports a violation.
- **Lens gate walks from the named scope.** A `$$.` ref is gated at the enclosing visit, a
  prefixed `field` on an array rule descends into the ancestor's relation, and a `$$.` ref
  from inside an open Json scope is gated at the declared ancestor it points back to.
- **Every lens walker carries the scope stack.** `applyLens` injects an ancestor relation's
  `where` into a prefixed array rule and re-roots to-one hop grants under the same prefix
  (`$$.customer.tenantId`), so narrowing cannot be sidestepped through a scope ref; a grant
  authored with a scope ref cannot be re-rooted and fails closed. `describeRule` resolves the
  ref, reports out-of-bounds as a violation, and drops the compile targets a scope ref
  cannot reach. `stampCoercions` stamps a prefixed field from the ancestor model.
  `ruleSourceValues` records a prefixed field's values at the ancestor source.
- **Compilers stay honest.** `toSql()` keeps `path: '$.x'` as a same-row column comparison;
  a `$$.` path or any prefixed `field` throws on both `toSql()` and `toPrisma()`
  (`validateRule` flags them as `unsupported_sql_field` / `unsupported_prisma_field` /
  `unsupported_prisma_path`). Prefix parsing lives in one place (`src/scope.ts`); `parseScopeRef`
  and `resolveScopeRef` are exported for consumers that draw a scope picker (the rule builder).

## 2.22.0 — `bindOptional`: a bind the caller may leave unsupplied

- **`bindOptional: true`** on a `{ bind }` leaf (`Rule`, `DateRule`, `AggregateRule` types). An
  unsupplied required bind stays a caller bug — `check()` throws `Missing binding`, `toPrisma` /
  `toSql` refuse a surviving token. An unsupplied optional bind resolves to `null` at the seam
  where absence is final: `check()` compares against `null`, both compilers compile the token as
  `null`. The leaf is evaluated as written and never pruned.
- **`requiredBindings(rule)`** now excludes names that are optional at every leaf (a name optional
  at one leaf and required at another is required); **`lensRequiredBindings`** follows. New
  **`bindingNames(rule)`** keeps every name, optional or not — `validateBindNames` uses it, so an
  optional bind still cannot collide with an ancestor's name and a `parent:` reference to one
  still has to resolve.
- `resolveBindings` drops the flag with the token it resolves; an unsupplied optional token stays
  in place (partial resolution is unchanged).
- `check()` bind lookup uses `Object.hasOwn`, matching `resolveBindings` — a bind named after an
  `Object.prototype` key no longer reads the prototype.

## 2.21.0 — `getAggregateOperators(target)`: the threshold list a target can compile

- **`getAggregateOperators(target?)`** — the aggregate threshold comparisons a target
  compiles, all of them when no target is given. `toPrisma()` builds the threshold as a
  Prisma `having` filter, which has no complement for a range, so `notBetween` drops
  there; `check()` and `toSql()` both handle it.
- **`validateRule` rejects off that list** instead of restating the `toPrisma` +
  `notBetween` pair inline, and its issue code follows the usual target slug —
  `unsupported_prisma_aggregate_operator` is unchanged, and another target's exclusion
  would name itself. Consumers that draw a threshold picker (the rule builder) can now
  derive the offered set for their own target instead of hardcoding the Prisma-safe
  subset for everyone.

## 2.20.0 — `ruleSourceValues(lens, rule)`: the values a rule names at each declared source

- The lens answers "which values does this rule use at source X" — keyed by its own source
  declarations (`projectByPath`'s `path` + `field` format), so a caller never spells a dotted
  path (the #9/#10 shape, rejected for exactly that). Resolution is `walkLensPath`, so
  visibility, the Json boundary, and `mapDefaults` all apply: a source declared in
  `mapDefaults` answers wherever its model appears, including relation chains
  `root.relations` never spelled. Nested and dotted relation spellings are one path; a
  windowing `filter` is walked at its relation anchor; an aggregate's threshold and an array
  `count` are not source values.
- Shape-aware via the operator catalog: only literal-naming shapes (`scalar`, `ordered`,
  `array`, `dayList`, `dateValue`) contribute `values`; substring / pattern / range / window
  operators — and operators the catalog does not know — mark the source `dynamic` instead of
  inventing values (`between: [a, z]` names a range, not two rows). `path` / `bind` at a
  source is `dynamic` by key *value*, not key presence (`path: undefined` is a literal leaf).
  Structured values dedupe by content (Dates, object literals).
- First consumer: the rule reference registry (Zealot ZLT-4441 / template INFRA-030) — every
  edge's referenced model is the source's model, never a constant, and `dynamic` is the
  fail-closed signal its save gate refuses on. `test/lens.ruleSourceValues.test.ts`; the
  adversarial findings that shaped the final semantics are each pinned by a test.

## 2.19.8 — negations through an optional to-one carry the absent relation

- Negations through an OPTIONAL to-one relation carry `{ rel: { is: null } }` per optional hop.
  The null arm was only ever the leaf's `{ rel: { col: { equals: null } } }`, which Prisma
  satisfies only when the relation EXISTS — so a row with no relation fell out of `notEquals`,
  `notIn`, `notExists`, `notBefore`, `notAfter` (and `isEmpty`) through it, while check() (path
  → undefined → complement) and toSql (LEFT JOIN → `IS NULL`) both kept it. Proven against real
  Prisma/MySQL on `FanUsers.lastFanMission`: five rules diverged before, none after. Licensing is
  the relation entry's `isRequired: false`, the same authority as the column arm
  (`absentArms` in `src/toPrisma/field.ts`; `test/toPrisma.absentRelation.test.ts`). The
  clause-level `NOT` of `notWithin` / `notBetween` already included the null relation.

## 2.19.7 — the range complements negate the clause, not the column filter

- `notBetween` and `notWithin` compiled to `{ col: { NOT: { gte, lte } } }`, which Prisma
  rejects outright (`Unknown argument \`NOT\``) — a rule that validated and compiled cleanly
  500'd the moment it ran. Prisma has no field-level negation of a two-sided range at all:
  it distributes `not` over the nested filter's keys, so the lowercase spelling is worse
  than the error — `NOT(col >= a) AND NOT(col <= b)` is unsatisfiable for any window, and
  it fails SILENTLY, reporting an empty audience while check() answers correctly on the
  same rule. Both now emit `{ NOT: { col: { gte, lte } } }`, the negation of the whole
  clause, which is what a complement means and what `toSql` has always emitted
  (`NOT BETWEEN`). The `equals: null` arm stays outside the `NOT`, as before.
- The single-boundary complements (`notBefore` / `notAfter`, 2.19.6) were never affected:
  they compile to a plain `gte` / `lte` and carry no negation.
- Pinned as a family invariant, not three literals: no column filter any negated operator
  emits may carry a clause-level `NOT` at any depth (`test/toPrisma.rangeComplement.test.ts`).


## 2.19.6 — `notBefore` / `notAfter`, the null-carrying boundary complements

- `onOrAfter X` is not the complement of `before X`: it is positive, so a null column
  never satisfies it. `notBefore X` (on/after X, or never) and `notAfter X` (on/before
  X, or never) are — negative-flavored under the negation ruling on every rail.
  `lastLoginAt notAfter '2026-01-01'` is "hasn't logged in since Jan 1, including never";
  `completedAt notBefore <deadline>` is "hadn't completed by the deadline, including never".
- Point operators: literal date, rolling point, or a period edge, exactly like
  `before`/`after`; a period anchors to the same edge as the positive form
  (`notBefore { this: 'month' }` is the month's start).
- Catalog: `dateValue` shape, `acceptsExpr`, all targets.

## 2.19.5 — `notWithin`, the complement of `within`

- New date operator `notWithin`: takes the same range expression as `within` (a
  period or rolling window) and matches outside it. Negative-flavored, so under the
  2.19.0 negation ruling a never-set date matches on every rail — check() returns
  true for null, toSql ORs `IS NULL`, toPrisma adds the `equals: null` arm on a
  nullable column. "Hasn't been seen in the last 30 days" is one leaf:
  `{ field: 'lastLoginAt', dateOperator: 'notWithin', value: { ago: { days: 30 } } }`,
  instead of the `any: [notExists, before]` pair the README had prescribed.
- Catalog: `dateWindow` shape, `acceptsExpr`, all targets — a builder that renders
  `within` renders this unchanged.

## 2.19.4 — five rail-parity fixes from the whole-project adversarial sweep

- `toSql` isEmpty/notEmpty: the ''-branch is String/Json-only (toPrisma's 2.18.3
  `acceptsEmptyString`, ported). A typed non-String column compiles to a pure null
  check — the documented `deletedAt isEmpty` soft-delete lens grant was
  guaranteed-unrunnable SQL (`timestamp = ''`).
- `toPrisma` count-step: `atMost N` compiles to NOT(atLeast N+1), `exactly 0` to
  NOT(atLeast 1) — a groupBy cannot emit zero-count groups, so roots with zero
  matching children were silently dropped and `exactly: 0` matched nothing.
  `atLeast 0` is everyone. Missing condition/count throw, as check() does.
- Date `path` values: toSql anchors context-path scalars through the same
  parse-and-anchor seam as literals; checkDate resolves `path` for
  between/notBetween instead of throwing on a rule validateRule accepts.
- `toSql` dayIn/dayNotIn: the weekday is computed in the resolved timezone — the
  column anchors as a UTC instant (Prisma convention) and converts to the zone,
  ending naive, so EXTRACT never consults the DB session's TimeZone GUC.
- Lens field-map lookups are own-property checks: a prototype member name
  ('constructor', '__proto__', 'toString') no longer resolves as a declared field
  that the policy gate approves and check() evaluates as unconditionally true.

## 2.19.3 — binds inside windowing filters are required and resolvable

- `requiredBindings` / `resolveBindings` never descended into a windowing `filter`,
  so a `{ bind }` inside one was reported as not required and survived resolution as
  an unresolved token. Both now walk it.
- `resolveBindings` looks up binds as own properties — a bind named `toString` no
  longer "resolves" from `Object.prototype` when the bindings map doesn't cover it.
- Internal: the condition grammar's child slots (`all` / `any`, `if` / `then` /
  `else`, `condition` + `filter`) are listed once, in `src/traverse.ts`, and both
  binding functions consume that walk — the slot lists were previously duplicated
  per function, which is how the `filter` blindness happened.
- The engine remains an evaluator: no rule-introspection API. A rule is blind to
  other rules; cross-rule concerns (reference graphs, ordering, remapping) belong
  to the caller that authors the rules.

## 2.19.2 — negated date operators keep NULL rows

- 2.19.1 made a null date column a non-match for every date operator. Right for the
  positive ones; wrong for the negative-flavored ones. Per the 2.19.0 negation ruling
  — not(X) is the complement of X, and no value does not satisfy X — a never-set
  date IS "not between January and June", and its day IS "not monday".
- `check()` now answers `true` for `notBetween` / `dayNotIn` over a null or absent
  field. `toSql` ORs an `IS NULL` arm onto both. `toPrisma` adds the `equals: null`
  arm on `notBetween` under the same field-map licensing as the plain negated
  operators (`isRequired: false`); `dayNotIn` still has no Prisma output.
- The positive date operators are unchanged: null is a non-match, the compilers stay
  bare, and the `notExists`-arm composition remains the way to claim never-seen rows.

## 2.19.1 — a null date column is a non-match, not a throw

- 2.19.0 aligned the engines on NEGATION over a NULL column; the date rail kept the
  last divergence. `checkDate` threw `"<field> is null or undefined"` for a missing
  value, while `toSql` / `toPrisma` emit a bare boundary (`<` / `BETWEEN`, `lt` /
  `gte`+`lte`) that a NULL column simply does not satisfy. The same stored rule
  crashed a per-row pass and classified the row cleanly in the batch pass — a
  segment "last login before 30 days ago" reported every never-seen member as
  unevaluable per row and as a non-match in bulk.
- `checkDate` now returns the rule's ordinary non-match (honoring `error`) when the
  field is null or absent, for every date operator. Symmetric with `exists`, which
  2.19.0 defined as "has a value".
- The guard is `== null`, not falsy: epoch `0` is a real instant (1970-01-01) and now
  compares instead of throwing, and `''` reaches the existing
  `"is not a valid date"` error instead of being misreported as absent.

## 2.19.0 — negation keeps NULL rows in both compilers

- `check()` already treated a negated operator as the complement of its
  positive form (`null !== 'x'` is true), while `toSql` / `toPrisma` emitted bare
  `<>` / `NOT IN` / `NOT LIKE` / `!~` / `NOT BETWEEN`, which SQL three-valued
  logic drops for a NULL column. The same stored rule gave opposite answers per
  engine on any nullable field — a segment "job title is not X" enrolled a fan
  with no job title in the per-user pass and evicted them in the batch pass.
- `toSql`: `notEquals` / `notIn` / `notContains` / `notMatches` / `notBetween`
  become `(… OR col IS NULL)`; `in` with a null member becomes
  `(col = ANY($1) OR col IS NULL)` and `notIn` with one becomes
  `(col <> ALL($1) AND col IS NOT NULL)`; column-to-column `equals` / `notEquals`
  (`path: '$.x'`) use `IS [NOT] DISTINCT FROM`.
- `toPrisma`: the same arms as `{ OR: [filter, { col: { equals: null } }] }`,
  gated on the field map's **new `FieldMapEntry.isRequired?: boolean`**
  (prisma-map already emits it). Nullability unknown → bare filter, as before,
  because `equals: null` on a NOT NULL column is a Prisma validation error.
- `check()`: `exists` / `notExists` are now `!= null` / `== null` — "has a
  value", matching `IS NOT NULL`, instead of key presence.
- Added `test/nullSemantics.test.ts`: a `check()` ↔ `toSql()` parity matrix over
  every field operator on a NULL row (PGlite), plus the `toPrisma` shapes.

## 2.18.4 — the Json boundary is open-ended all the way down

- 2.10.1 stopped `walkLensPath` at a Json column so `metadata.theme` would
  validate, but callers could not tell "the path ended ON the column" from "the
  path ended BELOW it". Two consequences, both fixed: the column's own allowed
  value set (`values`/`options`/`enumPicks`) gated its sub-paths — `metadata.theme
  equals 'dark'` was rejected as not in `metadata`'s allowed set — and a nested
  scope below the boundary was resolved against the *current model*, so
  `{ field: 'metadata.items', arrayOperator: 'any', condition: { field: 'color', … } }`
  reported `color` as an unknown field while a sibling name like `firstName`
  silently "resolved".
- `walkLensPath` now returns **`jsonSubPath`** — the segments consumed below the
  boundary, empty when the path ends on the declared entry. `checkRuleAgainstLens`
  and `describeRule` use it to open the nested scope: `condition`, `filter`,
  `orderBy`, `aggregate.field` and `$.` comparison refs below a Json column are
  accepted without resolution. A root-anchored `path` ref is still gated.
- Below the boundary the value kind is unknown, so no kind-specific narrowing
  applies — the generic operator set stands and `stampCoercions` leaves the rule
  unstamped, mirroring `check`'s untyped comparison of the traversed JSON value.
  Open-endedness remains exclusively a Json property: `firstName.foo` is still a
  violation, and no relation traversal resumes below a Json column.
- `describeRule` now visits a rule's `filter` against the descended target rather
  than the outer model, matching `checkRuleAgainstLens`.

## 2.18.3 — toPrisma: isEmpty/notEmpty stop comparing non-String columns to `''`

- The emptiness operators unconditionally emitted the `equals: ''` branch;
  Prisma rejects `''` on DateTime/Int/enum columns outright ("Expected ISO-8601
  DateTime"), so an authored `isEmpty` on any typed non-String column was a
  guaranteed runtime 500 (ZLT-3899). The `''`-branch is now String/Json-only:
  the field map is the authority (`walkFieldPath`'s `direct` result now carries
  the leaf column's map entry, resolved through to-one relation paths), a
  stamped `coerceType` is the fallback, and with no type information the legacy
  two-branch shape survives.

## 2.18.1 — executePrismaQueryPlan preserves compiled Date leaves

- `resolveStepRefs` walked every object while replacing `__step` sentinels,
  entry-copying compiled `Date` values into empty plain objects — Prisma then
  rejected the where with "Argument `_ref` is missing". Non-plain objects
  (Date/Decimal/Buffer) now pass through untouched. Latent since 2.17's date
  coercion started emitting real Dates into compiled wheres.

## 2.18.0 — composite `groupBy` + partition axes on the surface

- **`SourceSpec.groupBy: string | string[]`** — a source may partition by several
  axes at once (the (source, field, value) triple behind a 3-level cascade).
  Options now carry **`groups?: string[]`**, index-aligned with the axes —
  REPLACING 2.17's `group?: string` (one representation; 2.17's field shipped days
  ago with only @inixiative/rules-builder 0.19 consuming it). SQL aliases are
  indexed (`__group_0`, `__group_1`, …) and `__group*` names are reserved on
  grouped sources. Dedup/union/sort key on the full axes vector; an option is
  grouped all-or-nothing — any unreachable axis leaves it ungrouped, never partial.
- **The surface carries the partition axes**: `exposedSurface` stamps
  `FieldMapEntry.groupBy` (the normalized axes) on grouped fields, so a builder
  can pin a field's options from a sibling clause on its axis. Two paths declaring
  DIFFERENT axes for one (model, field) throw — a flattened surface field cannot
  carry two partition namespaces.
- **Source-`where` hop guards**: `traversalGuards` folds every traversed model's
  narrowing wheres for groupBy axes (strict, fail-closed) AND for every relation
  path a source `where` references (previously only groupBy hops were guarded —
  safe by coincidence). Hops shared across paths fold once. Replaces the exported
  `groupGuardClauses`.

## 2.17.1 — ancestor removals bind groupBy/label targets

- A parent layer's picks/omits bind a child source's `groupBy` hops and `label`
  columns (option data is client-visible); ancestor-identical specs stay allowed.

## 2.17.0 — grouped sources

- `SourceSpec.groupBy` (single dotted to-one path), `SourceOption.group`,
  `sourceValuesFromQueryRows`, tenancy guard fold on grouped traversals,
  `(group, value)` option identity through union/dedup/sort.

## 2.16.0 — `fuzzy` matching + scoped `engineGlobals.with()`

- **`fuzzy?: boolean | FuzzyConfig`** on field rules — typo-tolerant matching for `contains`/`notContains`, backed by `fastest-levenshtein` with the length-scaled token policy (short tokens exact, longer tolerate more; numbers are identity). `FuzzyConfig` is JSON-serializable — `{ maxDistance?: number; maxRatio?: number }` — where the two are **both caps** and the tighter wins (`{ maxRatio: 0.2, maxDistance: 2 }` = "≤20% of chars, but never more than 2"); with neither set, the default `0/1/2`-by-length curve applies. `check()`-only: `toPrisma`/`toSql` throw for a fuzzy rule (no server-side equivalent — evaluate in memory). Resolves `rule.fuzzy ?? engineGlobals string.fuzzy ?? false`.
- **`engineGlobals.with(partial, fn)`** — a scoped override: deep-merges `partial`, runs the synchronous `fn`, restores in `finally` (even on throw). JS run-to-completion makes a sync `fn` atomic, so overlapping evaluations never observe the override; an async `fn` would leak the scope, so it throws. Lets a FE bundle wrap one filter pass (`with({ string: { fuzzy: true, caseInsensitive: true } }, () => rows.filter(check(...)))`) without permanently mutating globals.

## 2.15.1 — `string.caseInsensitive` engine-global default

- Case-insensitivity is now settable once as an engine global instead of per rule: `engineGlobals.set('string.caseInsensitive', true)` makes every string operator (`equals`/`notEquals`/`contains`/`notContains`/`startsWith`/`endsWith`) match case-insensitively across `check`/`toSql`/`toPrisma`, with no per-rule flag. Resolution is `rule.caseInsensitive ?? engineGlobals string.caseInsensitive ?? false`, so a rule's explicit flag (either direction) still wins. Default stays `false` (unchanged behavior). Intended use: a FE bundle sets it once so its in-memory filter matches the backend's collation-insensitive matching, without stamping every rule.

## 2.15.0 — `caseInsensitive` flag + dialect-aware `toPrisma`

- Field rules take an optional **`caseInsensitive?: boolean`** (default falsey — existing rules unchanged, case-sensitive). When set, `equals`/`notEquals`/`contains`/`notContains`/`startsWith`/`endsWith` match string operands case-insensitively across all three evaluators: `check()` compares lowercased operands, `toSql` wraps both sides in `LOWER(...)`, and `toPrisma` emits Prisma's `mode: 'insensitive'`. No-op on non-string operands and other operators. First consumer is the FE in-memory filter (`useFilteredCollection`) — a member search for `cisco` now matches `Cisco Systems`, the in-memory dual of the backend's collation-driven `contains`.
- **`toPrisma` is now dialect-aware.** `mode: 'insensitive'` (Prisma `QueryMode`) is only accepted by the PostgreSQL/CockroachDB/MongoDB connectors; MySQL/SQLite are case-insensitive by collation and *reject* the argument. So `toPrisma` emits `mode` only when the resolved provider supports it — otherwise the plain filter is the correct output. Provider resolution: per-call `options.datasource.provider` → `engineGlobals` → default `postgresql`.
- **`engineGlobals`** — a small path-addressed store for engine-level compile settings (`engineGlobals.set('prismaOptions.datasource.provider', 'mysql')` / `.get(path)` / `.reset()`). Set once at the db-client boundary (fed by `prisma-map`'s parsed `datasource`) so no call site threads a provider; per-call `options.datasource` still overrides. Seeded from a deep-cloned default (`postgresql`), so `reset()` fully restores and writes never alias the default.

## 2.14.1 — `{}` is not a Condition: `SourceSpec` requires a key

- `SourceSpec` is now `{ where: Condition; label?: string } | { where?: Condition; label: string }` — at least one key required. The old all-optional shape let `{}` typecheck as a `sources` entry, fall past the `isSourceSpec` discriminant ('where'/'label' presence), and normalize to `{ where: {} }` — a non-Condition that `check()` fails for every row, so the field's option picker came back silently empty. Now `{}` is a type error, and `normalizeSource` throws at runtime for untyped callers (`sources: {} is not a Condition — use \`true\` for an unconstrained source`). The unconstrained spellings are `true` (bare) or a label-only `{ label }`; a `Condition` is a boolean, `all`/`any`/`if`, or a field predicate — never an empty object.

## 2.14.0 — `sourceValuesFromRows`: the in-memory sources executor

- **`sourceValuesFromRows(lensOrNarrowing, rows, options?)`** materializes each sourced field's option set from an already-fetched collection — the in-memory executor of `sources` declarations, alongside `sourceQueries` (which compiles the same declarations to DISTINCT queries for a DB). Rows are the collection fetched *under* the lens (relations inline, traversed per projection path, to-many arrays flattened), so they are already lens-scoped: eligibility is the field's source `where` only, evaluated via `check()` with `CheckOptions` passthrough for `{bind}` clauses. Scalar-list fields contribute one option per element, labels take the first non-null sibling, sorting is numeric-aware in a fixed locale (host-independent). Hoisted from `@template/ui`'s `sourceValuesFromRows`; `@inixiative/rules-builder`'s `runSources` remains the table-shaped variant (per-model row tables through compiled `sourceQueries`).
- Aliased relations are covered by test: two relation fields targeting the same model (`parents`/`children` → `User`) materialize independently per projection path — resolution goes through the entry's `type`, never the field name.

## 2.13.1 — deterministic DateTime coercion for naive strings

- `coerceType: 'DateTime'` now anchors a naive (zoneless) datetime string in UTC instead of the host's local zone via bare `Date.parse` — same rule + same rows give the same answer on every machine, matching the date rail's `parseDateValue` policy. (The fix missed the 2.13.0 tarball by one commit.)

## 2.13.0 — explicit value coercion: `Rule.coerceType` + `stampCoercions`

**`Rule.coerceType?: FieldKind`.** A field rule can declare the kind both sides coerce to before comparing — never inferred from the values (a date-looking string stays a string unless the rule says `DateTime`). `check()` applies it to the field value and the rule value (arrays element-wise): `DateTime` lands everything on epoch ms (Date instances, ISO strings in any zone/format, ms-timestamp strings), numeric kinds parse numeric strings, `Boolean` maps `'true'`/`'false'`, `String` stringifies primitives. `null`/`undefined` pass through untouched (the is-null sentinel is valid on every field) and an uncoercible value returns unchanged so the comparison fails with the rule's normal error instead of throwing on one dirty row. This closes the widget-authoring gap: a rule built from a date picker (`Date` object) or a stringified `SourceOption.value` (`'1'`) now matches wire-format rows. Plain operators without `coerceType` are unchanged; the `dateOperator` family still owns rich date semantics (zones, expressions, day-of-week).

**`stampCoercions(condition, lensOrNarrowing)`.** Walks a condition tree and stamps `coerceType` onto every field rule from the lens's field map — through `all`/`any`/`if`, dotted relation paths, and array/aggregate item conditions (stamped against the item's model). Existing `coerceType` values are preserved; enum/Json/unresolvable fields are left unstamped. This is the auto-inject seam for builders: the rule carries its coercion explicitly (serialization-safe), and producers stamp it mechanically from the lens instead of hand-picking kinds. `validateRule` rejects unknown `coerceType` values (`invalid_coerce_type`).

## 2.12.1 — lens-boundary fixes: hydrated-source option gating + `all`-grant filter-first

**Restore hydrated-source option gating.** `checkRuleAgainstLens` again gates a rule's value against a hydrated source's fetched **`options`** set, not only against an input `values` set. When a consumer folds `sourceValues` onto `field.options` (via `exposedSurface`/`projectByPath`) and re-feeds the exposed surface back into `checkRuleAgainstLens`, a value outside the fetched set is rejected. This was a regression in 2.12.0 (the `options` branch of the value gate was dropped as unreachable — but it's reached by the fold-then-gate consumer flow). Covered by `test/lens.sourceOptionsGating.test.ts`.

**`applyLens` `all`-grant is now filter-first.** A `where` grant under an `arrayOperator: 'all'` is injected into the array rule's window `filter` (dropped before order/take/skip and before the all-check), not realized as a per-row `¬scope ∨ condition` implication. The old implication was unsound two ways: (1) **security** — under a window (`orderBy`/`take`), `check` applied the window to the raw array first, so an out-of-scope row could take the slot and be exempted, bypassing the lens narrowing; (2) it rejected valid data when `negate` of an ordered comparator wasn't a true complement over a missing field. Filter-first fixes both, needs no operator inverse (so a `startsWith` grant no longer throws), and makes such rules `check()`-evaluated (the prefilter overmatches, `check()` narrows — the normal prefilter+check contract). Covered by `test/lens.applyLens.allFilterFirst.test.ts`. See `docs/LENS.md`.

## 2.12.0 — labeled source options, deterministic dates, lens-gate hardening

### Sources: labeled option sets (`options`)

- A `sources` entry now accepts a `SourceSpec` (`{ where?, label? }`) alongside the bare `Condition`; `label` co-selects a sibling column so each option carries a display label. Referenced-model option sets need no special form — declare the source at a relation-traversed narrowing node and it compiles over whatever model that path resolves to.
- The projected/exposed surface exposes a field's selectable set uniformly as `options: { value, label? }[]` (the `<select>` shape), enum fields included (label defaults to the value). The existing `values: string[]` stays as the validation/codegen input; `options` is **additive**.
- `SourceValues.options` (was `values: string[]`) and `SourceQuery.label` carry the label through `sourceQueries` → `exposedSurface`/`projectByPath`.

### Dates: deterministic, timezone-explicit evaluation

- `check()` date comparisons no longer depend on the host machine's timezone. Absolute instants (`Date` objects, epoch numbers, zone-stamped ISO strings) are used as-is; naive values (date-only, zoneless datetimes) are anchored in the evaluation's timezone; `dayIn`/`dayNotIn` compute the weekday in that timezone. **Behavior change / bug fix**: results are now stable across hosts (previously a host with a non-UTC offset could return a different answer for the same rule).
- The anchoring timezone resolves through one seam and is now **bindable**: `DateConfig.timeZone` accepts `string | { bind }` (`TimeZoneConfig`), resolved from `bindings` — precedence bound → literal → `'UTC'`. Per-record (companion-column) zones are documented as a future extension in `docs/TIMEZONE.md`.

### `isEmpty` / `notEmpty`: aligned with the compilers

- `check()` now treats a value as empty iff it is `null`, `undefined`, or `''` — matching `toSql` (`IS NULL OR = ''`) and `toPrisma` (`null | ''`). **Behavior change / bug fix**: a `Date` or a number is no longer "empty" (lodash `isEmpty` reported both as empty, so a soft-delete grant like `deletedAt isEmpty` wrongly passed deleted rows in the in-memory backend).
- `isEmpty`/`notEmpty` are now valid on any nullable field kind (not only `String`), so the documented soft-delete grant validates.

### Lens gate: closes three reference-escape holes

`checkRuleAgainstLens` now enforces what the docs claim ("a rule can't reference outside its lens"):

- Right-side `path:` references are gated the same way the left-side `field` is (a comparison ref must resolve through the narrowed lens) — previously an author could probe a hidden field through an equality/ordering oracle.
- Window `filter` (a full condition) and `orderBy` field refs are validated at the descended relation target.
- `applyLens` injects a related model's `where` grant on **to-one / mid-path** relation hops (e.g. `author.email`), re-rooted under the relation path — previously the grant was silently dropped for the most common relation shape. Where a grant can't be re-rooted unambiguously (a `path` ref, or a to-many hop with no array-operator anchor), `applyLens` **fails closed** (throws) rather than emitting an unenforced grant.

## 2.11.1 — bind resolution: key-presence contract

Resolving a `{ bind }` now distinguishes an **unsupplied** binding from one supplied as nothing — key presence is the contract:

- **Name absent from the `bindings` map → throw** (`check`, and the compilers). A forgotten scope must never silently run; the throw is now precise (key presence, not `value !== undefined`, so a present-but-`undefined` value no longer trips it).
- **Name present (even `null`/`undefined`) → use the value, normalizing `undefined → null`.** An explicitly-supplied nothing is a value (`where x = null` — a fail-closed filter), and `null` keeps the resolved condition clean serializable JSON. `resolveBindings`/`resolveLensBindings` still leave **absent** keys as tokens (partial resolution unchanged).
- **`toPrisma` / `toSql` reject a surviving `{ bind }` token** with an explicit "resolve bindings before compiling" error, instead of silently emitting `value: undefined`.

## 2.11.0 — context bindings

Context bindings: runtime-bound values in rules and narrowings (`{ bind }`), so a `where`/value can reference tenant context (e.g. the current brand) instead of a baked literal or a non-serializable closure. A bind **preprocesses into the lens** — resolve into the chain's `where`/`sources` first, then `applyLens`/`toPrisma`/`toSql`/`sourceQueries`/`projectByPath` consume a concrete lens **unchanged**, so the whole feature is additive. Full scope + design: `tickets/FEAT-004`.

**Condition-level:**

- **`{ bind }` value source** — a third arm of `ValueSource` (`{ value } | { path } | { bind }`), valid in any value position. Resolved from a `bindings` map at execution; a referenced-but-missing bind throws.
- **`check(rule, data, { bindings })`** resolves binds during evaluation.
- **`requiredBindings(condition)`** → the `Set<string>` of bind names a condition needs.
- **`resolveBindings(condition, bindings)`** → partial / progressive: substitutes covered binds, leaves uncovered ones as tokens.

**Lens-level (preprocess into the lens):**

- **`resolveLensBindings(lensOrNarrowing, bindings)`** — resolve binds across the chain's `where`/`sources` (relations + mapDefaults), returning a new concrete lens. Partial-safe, non-mutating.
- **`lensRequiredBindings(lensOrNarrowing)`** → `Set<string>` of names the lens needs; `parent:` refs collapse to base names. Pass `narrowing.parent` to see the names a child must not collide with.
- **`validateBindNames(narrowing)`** (run by `validateNarrowing`) — bind names are unique across a chain; a re-declared name **errors**. Reference an inherited binding read-only as **`parent:name`**.

**Out of scope:** `seal` dropped (the server is the sole executor — no off-server handoff to seal); serialization-by-ref is its own follow-up (INFRA-016) and the binding path doesn't need it.

## 2.8.0

Builder-surface primitives on the lens: a leak-safe exposed surface and a rule
source/target classifier.

### `exposedSurface(lensOrNarrowing) → Lens`

The total exposed surface of a (possibly narrowed) lens, **as a Lens** (maps
intact — the navigable graph), not a projection. Every model reachable from the
anchor through visible relation/bridge edges, with the full narrowing applied —
root at the anchor, path-specific along declared relation paths, `mapDefaults`
everywhere else — unioned per model. A field appears iff it is visible on at
least one reachable, narrowed path; fields hidden on every path (including those
hidden only by `root`) are absent, so it never exposes the raw, un-narrowed lens.
`where` is dropped, the enum registry carries only exposed values, and bridges
that touch an unexposed surface (no surviving bridge-field) are eliminated.
Cycle-safe, so recursive schemas (`User → Org → members(User) → …`) terminate.

This is the **server→client** builder surface. (A `where`-preserving collapse for
a server→subtenant handoff — `seal` — is planned separately.) Contrast with
`projectByPath`, which returns a path-keyed *view* (graph flattened).

### `describeRule(rule, lensOrNarrowing) → RuleDescription`

Static classification of a rule against a lens:

```ts
{
  sources: string[],          // map (source) names the rule's fields touch
  bridgesCrossed: boolean,    // any path crosses a bridge into another source
  supportedTargets: RuleTarget[], // check / toPrisma / toSql that can run it
  violations: string[],       // field paths that don't resolve through the lens
}
```

A bridge-crossing rule is `check()`-only (`toPrisma`/`toSql` can't join across
sources — hydrate foreign rows with `buildBridgeDictionary` and evaluate in
memory). `supportedTargets` intersects per-operator catalog support with bridge
and windowing restrictions (`toSql` never compiles a window; `toPrisma` only the
extremal array rewrite). For the full security gate use `checkRuleAgainstLens`.

## 2.7.0

Two additions: a **pre-window filter** stage on windowed rules, and **catalog
reflection** coverage for the 2.6 date/window primitives.

### Pre-window `filter`

Windowing now runs **filter → order → skip → take** before the predicate, so a
rule can scope *which rows enter the window* independently of the predicate it
tests. `filter` is a `Condition` on `WindowFields` (array and aggregate rules).

```ts
// "Of the user's COMPLETED missions, the most recent one was > 30 days ago."
{
  field: 'fanMissions',
  filter: { field: 'status', operator: 'equals', value: 'completed' },
  orderBy: [{ field: 'completedAt', dir: 'desc' }],
  take: 1,
  arrayOperator: 'all',
  condition: { field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } },
}
```

Without the filter, `take: 1` would select the latest mission of *any* status.
The filter is evaluated by `check` per element (full support). Compilation is
**check-only for now**: `extremalRewrite` bails when a `filter` is present, so
`toPrisma`/`toSql` throw the "evaluate with check()" error rather than miscompile
a filtered window. Compiling a filtered window to a filtered `every`/`some` is a
candidate for a later release.

### Catalog reflection for 2.6 operators

The builder-facing operator catalog now reflects the 2.6 date/window features it
was missing:

- New `ValueShape` **`dateWindow`** for `within` — distinct from `dateRange`.
  Previously `within` reported `dateRange` (a two-endpoint literal pair), which
  contradicted the validator (it requires a single period/rolling expression).
- **`acceptsExpr`** flag on date catalog entries — marks operators that accept
  structured date expressions (`{ ago: { days: 30 } }`, `{ this: 'month' }`, …)
  in addition to / instead of literal dates. True for all date operators except
  `dayIn`/`dayNotIn`.
- **`WINDOW_SELECTOR`** + `getWindowSupport(ruleType, target)` + `WindowSupport`
  — reflect the windowing fields and per-(ruleType × target) support: `check`
  full; `toPrisma` extremal for array, none for aggregate; `toSql` none.

A new `test/operatorCatalog.integrity.test.ts` enforces that every operator in
the `Operator`/`DateOperator`/`ArrayOperator` enums has a catalog entry (and no
extras), every date operator declares an explicit `acceptsExpr`, and the window
support matrix covers every rule-type × target — so future operator additions
can't silently skip the reflection.

## 2.6.0

Two additive primitives: relative/calendar **date expressions** and an ordered
**windowing** selector.

### Date expressions + `within` operator

`DateRule.value` now accepts structured, serializable date expressions. Positive
magnitudes only — direction lives in the keyword. Units are dayjs words
(`day`/`week`/`isoWeek`/`month`/`quarter`/`year`/`hour`/`minute`/`second`).

- **Point** (with `before`/`after`/`onOrBefore`/`onOrAfter`, or `between` endpoints):
  `{ ago: { days: 30 } }`, `{ ahead: { months: 2 } }`, `{ start: <period> }`, `{ end: <period> }`
- **Range** (with the new **`within`** operator): `{ this: 'month' }`, `{ last: 'week' }`,
  `{ next: 'quarter' }`, and rolling windows `{ ago: {…} }` / `{ ahead: {…} }`
- Bare period + `before`/`after` ⇒ implied edge (`before`→start, `after`→end).

```ts
// "more than 30 days ago"
{ field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } }
// "this month"
{ field: 'completedAt', dateOperator: 'within', value: { this: 'month' } }
```

`now` is an explicit evaluator input (no implicit `Date.now()`); `check`/`toPrisma`/`toSql`
throw when a relative/period expression is used without it. `timeZone` (default
`'UTC'`) and `weekStart` (default `'monday'` → isoWeek) are per-call options on the
existing options bags. Compilers resolve expressions to concrete `Date` bounds at
compile time, so all three targets compare the same instant.

### Windowing selector (`orderBy` / `take` / `skip`)

Array and aggregate rules accept an ordered-window selector that runs before the
predicate (pipeline: order → skip → take):

```ts
// "user whose last fanMission was more than 30 days ago"
{
  field: 'fanMissions',
  orderBy: [{ field: 'completedAt', dir: 'desc' }],
  take: 1,
  arrayOperator: 'all',
  condition: { field: 'completedAt', dateOperator: 'before', value: { ago: { days: 30 } } },
}
```

Empty-window semantics are author-driven (`all` is vacuously true; `atLeast: 1`
requires existence). `toPrisma` compiles the **extremal** case (`take: 1`, single
`orderBy`, monotonic condition on that field, aligned direction) by rewriting to
`every`/`some` — e.g. the rule above → `{ fanMissions: { every: { completedAt: { lt:
<now-30d> } } } }`. Other windowed rules (`take > 1`, `skip`, multi-key order,
non-monotonic/misaligned conditions) and all `toSql` windowing throw a clear
"unsupported; evaluate with check()" error rather than miscompile.

## 2.5.0

**Breaking:** `projectNarrowing` removed. `projectByPath` is the projection primitive.

The flat `FieldMapSet` shape `projectNarrowing` returned was structurally lossy — it couldn't represent "User looks different at `Post.author` vs `Post.editor`" when two sibling relation paths targeted the same model. Every attempt to pick a sibling-collapse semantic was wrong-by-shape: 2.2 chose intersection (silent ∅), 2.3 chose union (silently leaked sibling-only fields — a security regression for consumers using projection as an access whitelist), 2.4 reverted to intersection and added `projectByPath` alongside. 2.5 commits to path-keyed as the only projection primitive.

### Migration

```ts
// Before (≤ 2.4)
import { projectNarrowing } from '@inixiative/json-rules';
const projected = projectNarrowing(narrowing);
projected.maps.prisma.models.User.fields.email;        // model-keyed
projected.maps.prisma.enums?.UserRole;                  // separate registry
projected.bridges;                                      // pruned bridges array

// After (3.0)
import { projectByPath } from '@inixiative/json-rules';
const projection = projectByPath(narrowing);
projection.get('User')?.fields.email;                   // path-keyed (lens anchor here)
projection.get('User')?.fields.role?.values;            // enum values inlined per field per visit
// no separate `bridges` field — the bridge-key field's presence at each visit is the truth
```

Each key in `PathProjection` is the dotted path from the lens anchor (e.g. `"User"`, `"User.posts"`, `"User.posts.author"`). Composition at each visit: path-specific picks/omits/enumPicks/enumOmits (chain-intersected) ∩ `mapDefaults[X].models[Y]` for the target model (chain-intersected) ∩ `mapDefaults[X].enums` registry narrowing. Sibling paths to the same model stay independent — no leakage.

### What this fixes

- Sibling collapse on shared targets — `Post.author: { picks: ['name'] }` and `Post.editor: { picks: ['id'] }` now correctly project two independent visits, not a collapsed single User entry.
- Per-path enum divergence — `User.role` picks `['admin']` at root and `['member']` via `posts.author` projects two visits with distinct allowed values.
- Per-path `where` clauses — each visit carries the `where` clauses anchored at that path.

### Notes

- `resolveVisit`, `checkRuleAgainstLens`, `applyLens` were already path-correct via `relPath` descent. Unchanged.
- `validateNarrowing` unchanged.
- The pre-2.5 bridge-pruning logic (drop the `bridges[]` array entry when its key field was narrowed away) doesn't have a direct equivalent — `projectByPath` doesn't return a bridges array. The bridge-key field's presence at each visit is the truth; consumers walking the projection see what's reachable.
- See [docs/LENS.md §10](./docs/LENS.md) for the full API.

## 2.4.0

`projectByPath` — path-keyed lens projection. Also reverts 2.3.0's `projectNarrowing` sibling semantics back to 2.2's intersection.

### Why

`projectNarrowing` returns a flat `FieldMapSet` keyed by `(map, model)`. That shape cannot represent "User looks different at `sourceUser` vs `targetUser`" — when two sibling relation paths target the same model, the model-keyed output forces a single answer. 2.2 made that answer intersection (silently empty); 2.3 made it union (silently leaks sibling-only fields across paths). Both are wrong-shape for per-path consumers (validation whitelists, SDK schema generation, search-field enumeration). Neither was a real fix.

### `projectByPath(lensOrNarrowing) → Map<dottedPath, ProjectedVisit>`

Path-keyed and lossless. Each `dottedPath` (e.g. `"Inquiry"`, `"Inquiry.sourceUser"`, `"Inquiry.targetUser"`) gets its own `ProjectedVisit`:

```ts
type ProjectedVisit = {
  mapName: string;
  modelName: string;
  fields: Record<string, FieldMapEntry>;  // narrowed at THIS visit (enum values inlined)
  whereClauses: Condition[];              // collected at THIS visit
};
```

Composition at each visit: path-specific picks/omits/enumPicks/enumOmits (chain-intersected) ∩ `mapDefaults[X].models[Y]` for the target model (chain-intersected) ∩ `mapDefaults[X].enums` registry narrowing. Implemented on top of `resolveVisit` (which has been path-correct since 2.1).

```ts
import { projectByPath } from '@inixiative/json-rules';

const projection = projectByPath({
  parent: postLens,
  root: {
    relations: {
      author: { picks: ['name'] },
      editor: { picks: ['id'] },
    },
  },
});

projection.get('Post.author')!.fields;   // { name: ... }              — no editor.id leak
projection.get('Post.editor')!.fields;   // { id: ... }                — no author.name leak
```

For consumers needing to enumerate searchable / validatable paths through a lens, walk the projection:

```ts
const paths: string[] = [];
for (const [dottedPath, visit] of projection) {
  for (const [field, entry] of Object.entries(visit.fields)) {
    if (entry.kind === 'scalar' || entry.kind === 'enum') {
      paths.push(`${dottedPath}.${field}`);
    }
  }
}
```

### `projectNarrowing` reverted to 2.2 intersection

2.3's sibling-union behavior is removed. When two sibling paths target the same model, the model-keyed projection again intersects their picks (conservative — fails closed, never surfaces a path that wasn't declared at every reaching path). This is still lossy for per-path questions; consumers wanting per-path accuracy should use `projectByPath`. `projectNarrowing` remains useful as a "type surface (lowest common denominator)" view.

### Migration

- If you used `projectNarrowing` and depended on 2.3's union of sibling paths (rare — the union behavior was permissive in a way that would surprise most callers), switch to `projectByPath` and walk per-path.
- If you used `projectNarrowing` in 2.2 style (single-relation lenses, mapDefaults), no change needed — same behavior restored.
- New code that enumerates paths through a lens (validation, SDK schema, search): use `projectByPath`.

## 2.3.0

Bug fix in `projectNarrowing`: sibling relation paths pointing at the same model no longer collapse via intersection.

### What was wrong

`projectNarrowing` keyed its per-model accumulator by `${mapName}::${modelName}`. Two sibling relations to the same target (e.g. `Post.author` and `Post.editor`, both `→ User`) wrote to the same `prisma::User` accumulator, intersecting their `picks` and often producing an empty field set.

Per-visit resolution (`resolveVisit`, used by `checkRuleAgainstLens` and `applyLens`) was already path-correct — it descends `narrowing.root` via the visit's `relPath`, so per-visit semantics weren't affected. The bug was contained to the flat-projection output.

### What changed

- Path-specific narrowings now accumulate per `${mapName}::${dottedPath}` (each sibling path gets its own key). Chain composition WITHIN a path still intersects (monotonic restriction is unchanged).
- The projected `FieldMapSet` is still flat (model-keyed). To collapse sibling paths down to one model entry, the projection takes the **union** across sibling paths: a field is visible in the projection iff it's visible at *some* path that reaches the model.
- `mapDefaults[X].models[Y]` still applies everywhere `Y` is reached in map `X` and intersects with the path union — applies-everywhere narrowing still bites in the projection.

### Example

```ts
// Post.author -> User, Post.editor -> User (multiRelMap)
const n: LensNarrowing = {
  parent: postLens,
  root: {
    relations: {
      author: { picks: ['name'] },
      editor: { picks: ['id'] },
    },
  },
};
const out = projectNarrowing(n);
// 2.3: out.maps.prisma.models.User has BOTH name AND id (union across sibling paths)
// pre-2.3 bug:  prisma::User acc intersected ['name'] ∩ ['id'] = {} — User vanished
```

For path-specific views into a descended model (where the AI/builder needs to know "at *this* path, only X is visible"), use `resolveVisit(policy, mapName, modelName, relPath)` directly — that's been path-correct since 2.1.

## 2.2.0

Structural cleanup of `LensNarrowing`. The path-specific anchor and per-map applies-everywhere defaults now live as separate top-level fields — `root` and `mapDefaults` — replacing the dual-purpose `maps` dictionary and the root-level `where` outlier. Composition semantics are unchanged.

### The shape

```ts
type LensNarrowing = {
  parent: Lens | LensNarrowing;
  root?: ModelNarrowing;                         // path-specific, anchored at (lens.mapName, lens.model)
  mapDefaults?: Record<string, NarrowingDefaults>; // per-map applies-everywhere
};
```

`root` descends via `.relations` (across maps via bridges). `mapDefaults[X].models[Y]` and `mapDefaults[X].enums[E]` apply wherever Y / E is reached in map X.

### Example

```ts
// Path-specific scope at the lens anchor + everywhere-soft-delete on Comment
const narrowing: LensNarrowing = {
  parent: lens,
  root: {
    where: { field: 'tenantId', operator: Operator.equals, path: 'tenantId' },
    relations: {
      posts: { picks: ['id', 'title', 'comments'] },
    },
  },
  mapDefaults: {
    prisma: {
      models: {
        Comment: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
      },
      enums: {
        UserRole: { omits: ['guest'] },
      },
    },
  },
};
```

The three `where` anchor layers now read as:

- `root.where` — root visit of the lens anchor
- `mapDefaults[X].models[Y].where` — wherever Y appears in map X
- `root.relations[R]...where` — only when the rule descends through R

### Strictness expansion: enum validation

`validateNarrowing` now applies the same monotonic-restriction check to enum narrowing that 2.1 already applied to picks/omits. Per-field `enumPicks/enumOmits` are checked against same-layer + ancestor `mapDefaults[X].enums[type]`, same-layer + ancestor `mapDefaults[X].models[Y].enumPicks/enumOmits[field]`, and ancestor's same-position narrowings. Narrowings that previously silently composed to a tighter set than declared now throw at construction.

### Internal cleanup that came with it

`validatePathNarrowing` now derives per-visit defaults from the chain on each hop — cross-map / cross-model descent picks up the right `mapDefaults[targetMap].models[targetModel]` per visit, fixing a pre-existing bug where the lens anchor's defaults were applied at every descended model. The "lens-level where: anchored to root" special case in `policy.ts` is gone; root wheres now flow through the same per-visit accumulator as everything else.

## 2.1.0

Major lens v2.1: schema-narrowing + data-narrowing as first-class primitives, with composition that respects anchoring instead of blindly AND-ing at root.

**Why this matters:** v2.1 turns the lens into a real containment layer for less-trusted callers — LLM agents, customer-facing UIs, third-party integrations. Schema narrowing (`picks` / `omits` / `enumPicks` / `enumOmits`) makes restricted fields *invisible*; the rule author literally can't reference them. Data narrowing (`where`) anchors row-scope constraints to the model they describe, so a `Comment.deletedAt IS NULL` scope travels into the comment subtree of a user's rule instead of being blindly AND'd at the root. Composition across the chain is pure intersection — no narrowing can re-add what a parent removed. Hand a caller a narrowed lens, let them author whatever rule they like, and the lens enforces the boundary at compile time.

### Breaking (type-level)

- **`FieldMap` shape changed** from `Record<string, ModelEntry>` to `{ models: Record<string, ModelEntry>; enums?: Record<string, readonly string[]> }`. Every consumer of `FieldMap` needs to access models via `map.models[X]` instead of `map[X]`. Required to give each FieldMap its own enum registry (avoids cross-source enum namespace collision) and to keep room for future schema-level additions.
- **`LensNarrowing.constrains` renamed to `LensNarrowing.where`.** Same shape, name change. The renaming reflects the filter-first semantic explicitly — the field is a SQL-like `where` clause that scopes which rows are in scope, not a generic constraint. Migration: `find/replace constrains → where` in narrowing declarations.

### Lens narrowing v2.1

Two distinct kinds of narrowing now live in `MapNarrowing`:

- **Schema narrowing** (controls what's visible in the type surface): `picks`, `omits`, `enumPicks`, `enumOmits`. SDK/AI cannot reference narrowed-away fields or enum values.
- **Data narrowing** (controls which rows are in scope): `where`. Filter-first semantic — anchored to the model it describes, NOT blindly AND'd at root.

New shape:

```ts
type FieldMap = {
  models: Record<string, ModelEntry>;
  enums?: Record<string, readonly string[]>;
};

type ModelDefaultNarrowing = {
  picks?, omits?, enumPicks?, enumOmits?,
  where?: Condition;   // no `relations` — relations are path-specific
};

type ModelNarrowing = ModelDefaultNarrowing & {
  relations?: Record<string, ModelNarrowing>;
};

type EnumNarrowing = { picks?, omits? };

type MapNarrowing = {
  models: Record<string, ModelNarrowing>;     // path-specific
  defaults?: {                                 // applies-everywhere
    models?: Record<string, ModelDefaultNarrowing>;
    enums?: Record<string, EnumNarrowing>;
  };
};
```

Composition: pure intersection across all layers. Each chained narrowing further restricts the surface.

### Center-of-gravity: `src/lens/policy.ts`

New internal `resolvePolicy(lensOrNarrowing)` + `resolveVisit(policy, mapName, modelName, relPath)` resolver. Single source of truth for "what's visible / what's allowed / what wheres apply" at any model visit. `checkRuleAgainstLens`, `applyLens`, and `validateNarrowing` all use it instead of reimplementing composition.

### Anchored `where` composition (`applyLens` rewrite)

`applyLens` is now AST-aware. Walks the user rule and injects `where` clauses at the correct anchor point in the rule tree:

- Root-level wheres (`LensNarrowing.where`, `models[rootModel].where`, `defaults.models[rootModel].where`) — AND at root.
- `defaults.models[M].where` — injected wherever the rule visits model M.
- `relations[R].where` — injected when the rule descends into relation R.

Operator-specific injection inside an `arrayRule.condition`:

- `any` / `none` / `atLeast` / `atMost` / `exactly` / `aggregate.condition`: AND injection (`{ all: [where, original] }`).
- **`all`**: filter-first via implication (`{ any: [negate(where), original] }`) so the user's "every row matches" semantic operates on the filtered set rather than rejecting out-of-scope rows. New internal `negate()` helper handles inversion using existing negative operators (`notEquals`, `notIn`, `none`, etc. + De Morgan for compound conditions). Throws clearly on `startsWith` / `endsWith` / `exactly` (no inverse in DSL).

### Path-aware `checkRuleAgainstLens`

Walks the narrowing tree per-path alongside the user rule, instead of validating against a flat projected set. Same model reached via different paths (e.g. `User.manager` vs `User.posts.author`) honors per-path narrowings independently.

### Enum value validation

`checkRuleAgainstLens` rejects rule values not in the resolved enum set, considering `FieldMap.enums` (registry) ∩ `FieldMapEntry.values` ∩ `defaults.enums[T]` ∩ `enumPicks/enumOmits[field]`. Covers leaf rules and nested rules inside `all`/`any`/`if`/`arrayRule.condition`.

### Strict `validateNarrowing`

Each narrowing layer can only mention fields/enum values still visible from layers above and the same layer's defaults. Picks/omits/enumPicks/enumOmits referencing already-excluded items throw clearly at construction. `relations` declared on a `ModelDefaultNarrowing` throws (runtime safety net for type-bypass). `where` clauses validate against the model they anchor to.

### `projectNarrowing` composition fix

The pre-2.1 last-write-wins bug (multiple narrowings of the same model with overlapping picks would erase prior fields) is fixed. Composition is intersection across all layers — each layer further restricts.

### Source hygiene test

New `test/sourceHygiene.test.ts` rejects invisible control characters (NUL, etc.) in source files — caught one such byte that was hiding in the v2.1 work before commit.

### Tests added (130+)

- `v2_1.composition.test.ts`, `v2_1.defaults.test.ts`, `v2_1.enumNarrowing.test.ts` — schema narrowing + defaults composition
- `v2_1.validateNarrowing.test.ts` — strict inheritance rules
- `v2_1.pathAware.test.ts` — same-model-different-path narrowing
- `v2_1.anchoredConstrains.test.ts` — per-operator anchored where injection
- `v2_1.enumValueValidation.test.ts` — rule value enum membership
- `v2_1.deepPathLockdown.test.ts` — narrowed-away paths rejected
- `v2_1.arrayOpNarrowingSemantics.test.ts` — end-to-end array operator semantics with real data

667 total tests pass, typecheck + lint clean.

## 2.0.3

Hardening note from external review: the `conditionTouchesBridge` guard added in 2.0.1/2.0.2 stopped at outer field paths and did not recurse into `arrayRule.condition` or `aggregate.condition`. A bridge field hidden inside `some`/`every`/`none`/`aggregate` sub-conditions, under an `if`/`then`/`else`, still corrupted the implication semantics — silently dropping branches.

### Fixes

- **`toPrisma` and `toSql` `conditionTouchesBridge` walkers** now recurse into the nested `condition` of `arrayRule` and `aggregate` rules, flipping the model context to the relation target (via a new `resolveRelationTargetModel` helper). A bridge anywhere in the if-clause subtree — at any depth — now triggers the over-fetch (`{}` / `'TRUE'`).

### Tests added (5)

- `test/bridgeIfThen.nestedSubCondition.test.ts` — bridge inside `if`/`then` `arrayRule.condition`, bridge buried two levels deep inside an `all` inside `arrayRule.condition`, toSql guard-catches-before-throw case.

## 2.0.2

Second hardening pass — fixes the round-3 review findings: ESM consumers were broken in 2.0.0/2.0.1, plus three more silent miscompiles symmetric to (or missed by) the 2.0.1 fixes.

### Fixes

- **ESM build broken for Node consumers** — `dist/index.js` emitted `import { get, ... } from 'lodash'`, which fails at runtime because lodash is CJS-only and provides no named ESM exports. Switched all source imports from `lodash` to `lodash-es` and bundled it (dropped from tsup `external`) so both ESM and CJS artifacts are self-contained. CJS consumers no longer get an `ExperimentalWarning` from require()-ing an ES Module.
- **`toSql` bridge if/then under-fetch** — mirror of the 2.0.1 toPrisma fix; bridge predicates compile to `'TRUE'`, then `NOT(TRUE) OR then` collapses to `then`, silently dropping branches in the `else` variant. `toSql/logical.ts` now applies the same `conditionTouchesBridge` guard across `if` / `then` / `else` and emits `'TRUE'` (over-fetch) when any sub-clause hits a bridge.
- **`else: false` was silently skipped** — `condition.else` truthiness checks in `check.ts`, `toPrisma/logical.ts`, and `toSql/logical.ts` meant `else: false` (a legal deny-branch condition) was treated as no-else. Now use `!== undefined`. `toPrisma` also handles `then: false` / `else: false` by emitting the same match-nothing pattern that `buildAny` uses for empty arrays (instead of letting `buildCondition(false)` throw).
- **`toPrisma` `some`/`every`/`none` used parent model for inner conditions** — `buildArrayLeafFilter` passed `options` unchanged into the inner `buildCondition`, so JSON-path and bridge detection misfired against the parent model rather than the relation target. Now resolves the relation target via `resolveRelationTarget` and threads `{ ...options, model: targetModel }` into inner calls.

### Dependency changes

- `lodash` removed from runtime dependencies.
- `lodash-es` added as a devDependency (bundled, not a runtime dep).
- `@types/lodash` → `@types/lodash-es`.

### Tests added (12)

- `test/toSql.bridgeIfThen.test.ts` (5)
- `test/elseFalse.test.ts` (4)
- `test/toPrisma.relationModelContext.test.ts` (3)

ESM/CJS smoke tests via `node` verify both artifacts import cleanly.

## 2.0.1

Hardening release surfaced by two adversarial review rounds. No API changes; all fixes are bug fixes or new loud-failure paths replacing prior silent miscompiles.

### Fixes

- **`toPrisma` if/then/else with bridge sub-clauses** — when any of `if`/`then`/`else` referenced a bridge field, the implication encoding `NOT(if) OR then` collapsed in Prisma (because `NOT: {}` is match-nothing), silently dropping the `then` or `else` branch and producing wrong query plans. `buildIfThenElse` now detects bridge-tainted sub-clauses via `conditionTouchesBridge` and short-circuits to `{}` (over-fetch), letting the caller's `check()` filter precisely.
- **`toPrisma` `FieldMapSet` without `mapName`** — `normalizeOptions` silently passed a `FieldMapSet` through as if it were a `FieldMap`, producing queries lacking JSON-path detection and bridge handling. Now throws `toPrisma: 'map' is a FieldMapSet — 'mapName' is required`.
- **`buildBridgeDictionary` reversed-endpoint silent dedup** — the convention is endpoint[0] = "one" side, endpoint[1] = "many" side; reversed bridges produced wrong `isList` flags in stitching AND silently deduped rows via `keyBy`. Added `keyByUnique` helper that throws on duplicate `on` values with a fix hint; documented the convention on `Bridge` via JSDoc.
- **`buildBridgeDictionary` null FK values** — many-side rows with `null`/`undefined` `on` values were grouped under string keys `'null'`/`'undefined'` by lodash `groupBy`, creating spurious joins. Now filtered before grouping.
- **`check()` `arrayOperator` over primitive arrays** — `all`/`any`/`none`/`atLeast`/`atMost`/`exactly` over a primitive-only array threw, breaking the `boolean | string` contract and allowing a rule-driven crash of the caller process. Now returns a descriptive error string (respects `condition.error` override).

### Tests added (19)

- `test/toPrisma.bridgeIfThen.test.ts` (5)
- `test/toPrisma.fieldMapSet.test.ts` (4)
- `test/buildBridgeDictionary.reversed.test.ts` (2)
- `test/buildBridgeDictionary.nullKey.test.ts` (2)
- `test/check.primitiveArray.test.ts` (6)

## 2.0.0

First version of the **Lens** primitive — schema-aware view layer with cross-source bridges and recursive narrowings. New compile-time boundary semantics in `toPrisma` and `toSql`. Operator catalog as canonical source of operator/target/kind/value-shape facts. `pg` removed from runtime dependencies.

### Breaking (type-level)

- `FieldMapEntry.kind` widened from `'scalar' | 'object' | 'enum'` to include `'bridge'`. Exhaustive `switch (kind)` consumers without a `default` will fail TS narrowing — handle the new kind or default to ignore.
- `BuildOptions.map` widened from `FieldMap` to `FieldMap | FieldMapSet`. Code that passed `options.map` straight to functions typed as `FieldMap` will need a cast or normalization (or use the new `mapName` field, which triggers automatic resolution at the toPrisma entry).
- `FieldMapSet` restructured from `Record<string, FieldMap>` to `{ maps: Record<string, FieldMap>; bridges?: Bridge[] }`. Bridges live declaratively on the set instead of being a separate argument.
- `stitchFieldMaps` signature changed from `(set, bridges)` to `(set)` — bridges are read from `set.bridges`.
- `BridgeEndpoint` now requires `on: string` — the field on this endpoint that participates in the join.
- `RuleValidationTarget` removed; `RuleTarget` (from `operatorCatalog`) takes its place. Same string union.
- `check(rule, data)` third arg is now an options bag `{ context? }` instead of a raw context value.

No runtime behavior changes for callers not using the new primitives.

### Lens primitive

- **`Lens`** — `FieldMapSet & { mapName: string; model: string }`. Pure schema; no runtime data. Single sanctioned construction path is `createLens({ maps, bridges?, mapName, model })` which stitches bridges internally.
- **`FieldMapSet`** — `{ maps, bridges? }` declarative shape; multi-source schemas express cross-source edges inline.
- **`Bridge`** — bi-directional edge between two `(fieldMap, model, on)` endpoints with `cardinality: 'oneToOne' | 'oneToMany'`. Stitched as `kind: 'bridge'` pseudo-fields on each endpoint model.
- **`LensNarrowing`** — recursive tree: `parent` → `maps[name].models[name]` with `picks`/`omits`/`relations`. Children narrow further only. Lens-level `constrains?: Condition` ANDs into any rule evaluated against the lens.
- **`applyLens(rule, narrowing)`** — composes chain constraints with the user rule: `{ all: [...chainConstraints, rule] }`. The rule-side composer.
- **`projectNarrowing(lens)`** — produces the effective `FieldMapSet` after applying the narrowing chain. The schema-side composer.
- **`checkRuleAgainstLens(rule, lens)`** — walks rule AST, returns `{ ok, violations }` against the projected surface; context-aware (inner conditions resolve against relation target, not lens root).
- **`validateNarrowing(narrowing)`** — structural + parent-chain cascade rules; validates `constrains` paths.
- **`stitchFieldMaps(set)`** — injects bridges into a FieldMapSet's maps. Validates `on` references a real field per endpoint; rejects self-bridges.
- **`buildBridgeDictionary(set, rawData)`** — utility for callers: takes raw foreign arrays, returns dicts keyed by each endpoint's `on` field, nested map → model → on → identifier. 1-1 via `keyBy`, 1-many via `groupBy`. Supports the same model on multiple bridges with different `on` fields.

### Operator catalog (new)

- **`OPERATOR_CATALOG`** — canonical `Record<Operator | DateOperator | ArrayOperator, { kinds, targets, valueShape }>` across `FIELD_OPERATOR_CATALOG`, `DATE_OPERATOR_CATALOG`, `ARRAY_OPERATOR_CATALOG`. `validate.ts` reads exclusively from the catalog; per-operator switches in validate replaced with `getValueShape` + `isOperatorSupportedForTarget` lookups.
- **`FieldKind`** — `String | Boolean | Int | BigInt | Float | Decimal | DateTime | Json | Bytes | Enum`.
- **Kind groups** — `NUMERIC_KINDS`, `ORDERABLE_KINDS`, `STRINGY_KINDS`, `EQUATABLE_KINDS`, `ALL_KINDS`. `Json`/`Bytes` excluded from `EQUATABLE_KINDS`.
- **`ValueShape`** — `'none' | 'scalar' | 'ordered' | 'array' | 'string' | 'pattern' | 'range' | 'dateValue' | 'dateRange' | 'dayList' | 'count' | 'predicate'`. The picker-layout contract for FE consumers.
- **Helpers** — `getOperatorsForKind(kind, target?)`, `getArrayOperators(target?)`, `getValueShape(op)`, `isOperatorSupportedForTarget(op, target)`, `isAggregateSingleOperator(op)`, `isAggregateRangeOperator(op)`. All exported.

### Engine

- **`check(rule, data, options?)`** — options bag `{ context? }`. Propagates through recursive helpers (`all`/`any`/`checkArray`/`checkAggregate`/`checkIfThenElse`).
- **Root-array `check()`** — when `data` is an array, the rule must be a tree of `all`/`any` whose leaves are fieldless `ArrayRule`s. Validated upfront via `validateRootArrayShape`; `ArrayRule.field` is optional. `toPrisma`/`toSql` compilation of fieldless `ArrayRule`s is not yet implemented.
- **Bridge keys at eval time** — engine walks paths via plain `lodash.get`; foreign rows attached under `<fieldMap>:<Model>` keys on data work without any lens-aware resolution. 1-many bridges produce arrays; intermediate-index path resolution works (`'crm:Event.0.x'`), no-index intermediate returns undefined (documented).

### Compile-target changes

- `toPrisma`: emits `{}` (Prisma "match anything") for any predicate whose field path hits a bridge. No-op in AND, over-fetches in OR. Caller follows up with in-memory `check()` against hydrated cross-source data.
- `toPrisma`: normalizes `BuildOptions.map` at entry — if `mapName` is set, resolves `(map as set)[mapName]` to a single FieldMap.
- `toSql`: emits `'TRUE'` for any rule whose field path hits a bridge.

### Dependencies

- **`pg` removed entirely.** Was an optional peerDependency in 1.3.4 but the bundled artifact still imported `escapeIdentifier from 'pg'`, breaking consumers. The one-line identifier escape is now inlined in `src/toSql/escape.ts`. `@types/pg` also dropped.
- Runtime deps: `dayjs`, `lodash`. Nothing else.

### Hardening (adversarial review fixes)

- `stitchFieldMaps` validates `BridgeEndpoint.on` references a real field on the endpoint model; rejects self-bridges.
- `projectNarrowing` clones `bridges` (was aliased by reference).
- `checkRuleAgainstLens` is context-aware — paths in `arrayRule`/`aggregate` conditions resolve against the relation target.
- `validateFieldMapSet` skips bridge entries (stitched outputs no longer fail validation for containing `:`).
- `getRoot` / `collectChain` / `applyLens` detect cycles in narrowing parent chains via a visited set; throw clearly instead of looping.
- `StrictArrayRule.field` optional (matches relaxed `ArrayRule`).
- `applyLens` uses `!== undefined` check on `constrains`, so `constrains: false` (deny-all) is preserved.

## 1.3.4

- Move `pg` to optional peerDependency, fix dayjs ESM imports. **Broken**: bundle still imported `pg` at runtime. Fixed in 2.0.0.

## 1.3.3 and earlier

See git history.
