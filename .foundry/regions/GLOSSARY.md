# json-rules glossary

**Every term json-rules's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs by the region pipeline's assemble.py. A term defined by two regions appears once per region. -->

---

## A

**absent set**  
A path's missing values: a NULL leaf or a NULL optional to-one hop. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**absent, not hidden**  
A row a relation's where filters out is absent from the SQL join, though check() treats it as hidden. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**absent: 'unknown'**  
CheckOptions setting: a missing path is unknown, so operators fail unless the row pins the value. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**absolute instant**  
A Date, epoch number, digit string, or string with Z / offset / GMT / UTC; used as-is. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**aggregate rule**  
`{ field, aggregate: { mode: 'sum' | 'avg', field? }, condition?, operator, value }`: compare a sum or avg. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**alias**  
The root table alias toSql qualifies columns with; t0 by default when map and model are given. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**all / any**  
AND / OR over child conditions. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**anchor**  
The place in the rule tree where a clamp is ANDed: the root visit, every visit of a model, or one relation descent. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**anchor**  
The place in the rule tree (root or a relation visit) where a clamp is injected. *Region:* [Using a lens](using-a-lens/knowledge.md)

**andWhere**  
AND compiled wheres with your own filters, folding match-all and match-nothing. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**AnyNull**  
Prisma's Json null sentinel, taken from your @prisma/client; matches DB NULL, JSON null and an absent path. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**array rule**  
`{ field, arrayOperator, condition?, count? }`: test array elements. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**array-aggregate-windowing**  
Class: array rules, aggregate sum / avg rules and filter -> orderBy -> skip -> take windows, orderRecords. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**ArrayOperator**  
all, any, none, atLeast, atMost, exactly, empty, notEmpty. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**assertValidFieldMaps**  
The throwing form of validateFieldMaps. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**assertValidNarrowing**  
Throws on the issues validateNarrowing reports. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**avg of nothing**  
NULL on every rail: a positive comparison fails, a negated one holds. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

## B

**Backend Support Matrix**  
README table of capabilities per rail: check / toPrisma / toSql. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**bare period**  
A period with before / after resolves to the only sensible edge (before the start, after the end). *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**base lens**  
The unnarrowed lens: every anchor column, no relation turned on. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**base lens**  
The unnarrowed lens a chain roots at; `{ lens }` compiles run against it. *Region:* [Using a lens](using-a-lens/knowledge.md)

**bind**  
`{ bind: 'name' }`: a placeholder for a caller-supplied value. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**bindings**  
Class: `{ bind }` placeholders, bindOptional, bindRule, listBindings, listFields, check's bindings, bindLens / listLensBindings. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**bindings**  
check / evaluateValue option: the map of bind names to values. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**bindLens / listLensBindings**  
The lens forms: bind or list the binds a narrowing chain's where and sources use. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**bindOptional**  
`bindOptional: true`: an unsupplied bind reads null; the leaf is never pruned. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**bindRule**  
Substitute covered binds, leaving the rest (partial resolution); required before toPrisma / toSql. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**Bridge**  
A cross-source edge: two endpoints `{ fieldMap, model, on }` and a cardinality. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**bridge field**  
The '<map>:<Model>' key under which far-side rows sit inline on a candidate (the indexBridges shape). *Region:* [Field option sources](option-sources/knowledge.md)

**bridge key**  
`<fieldMap>:<Model>`, a plain object property on a row holding the foreign row(s). *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**bun run check**  
prisma generate for test/rails, typecheck, biome check and bun test in one command. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

## C

**candidates**  
Over-fetched rows of a bridged source query, a superset of the true options. *Region:* [Field option sources](option-sources/knowledge.md)

**cardinality**  
The bridge's shape (e.g. oneToMany); decides list vs single on each side. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**check**  
Evaluate a rule against a row or array of rows; true or a failure message. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**check()**  
The in-memory evaluator, the reference the compiled rails must agree with. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**child slots**  
Where a node holds sub-conditions: all / any, if / then / else, condition, window filter. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**childless parent**  
A parent with no children: its sum is 0, its avg is NULL. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**clamp**  
A narrowing's `where`: rows it fails are hidden; it never grants access. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**clamp**  
A narrowing's `where` (data narrowing) that admits only matching rows at a visit. *Region:* [Using a lens](using-a-lens/knowledge.md)

**clampLens**  
ANDs server-set `root.where` and mapDefaults where / sources into a lens's first layer. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**clock.finestUnit**  
Engine global capping the finest unit a rule may name; evaluating or clockUnit throws past it. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**clock.finestUnit**  
The finest unit a date rule may name (default 'second'); finer throws or reports clock_unit_below_floor. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**CLOCK_UNITS**  
The ordered clock units, second to year. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**clockUnit**  
The finest clock unit a rule's answer can change by while data stays the same; null if no clock is read. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**coerceRule**  
Stamp each field rule lacking one with its field's coerceType from the lens. *Region:* [Using a lens](using-a-lens/knowledge.md)

**coerceType**  
On an aggregate rule, parses Json-array string items (Float, Int, Decimal) as SQL's ::numeric does. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**coerceType**  
Field or aggregate rule key parsing a string value as a number, Boolean or date before comparing. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**coerceType**  
Parse mode on a field rule or aggregate reading mixed-kind values as one kind (e.g. 'Int', 'Decimal', 'DateTime'). *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**coerceValue**  
Stamp `coerceType: 'DateTime'` on distinct / min / max aggregates from the lens. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**collation caveat**  
`=` and IN follow the column's collation; MySQL _ci columns match case-insensitively. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**column path compare**  
A `{ path }` value; toPrisma compiles it only same model, same visit, same type, as a field reference. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**column reference**  
`{ __field }` in a plan for a column-to-column compare, resolved by executePrismaPlan into a Prisma field reference. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**columns**  
Map from a field path to the caller's SQL expression, used as written; a missing path throws. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**composedWhere**  
The node's where AND the source's eligibility, narrowed under the lens as a rule is. *Region:* [Field option sources](option-sources/knowledge.md)

**composeLens**  
Rebuilds a lens from StoredLens records by id, validating each layer; fails closed. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**Condition**  
The generic rule type: Rule | AggregateRule | ArrayRule | DateRule | All | Any | IfThenElse | boolean. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**ConditionShape**  
Public runtime const and type naming node shapes: all, any, if, field, aggregate, array, date. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**createLens**  
Build a lens from `{ maps, bridges, mapName, model }`, stitching bridges in as fields. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

## D

**data narrowing**  
`where`: which rows are in scope; the field stays visible. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**datasource.provider**  
toPrisma option naming the connector, deciding whether mode: 'insensitive' is written. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**Date rule**  
`{ field, dateOperator, value }`: compare a date field with a date or a date expression. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**DateExpr**  
A serializable relative or calendar date value: RollingExpr, PeriodExpr or EdgeExpr. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**DateOperator**  
Runtime const object of date operators: before, after, onOrBefore, onOrAfter, notBefore, notAfter, within, notWithin, between, notBetween, dayIn, dayNotIn. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**DateOperator**  
Date-rule operators (before, after, within, dayIn, …). *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**dates-and-clock**  
This region's class: date operators, relative and calendar DateExpr, the explicit clock, zone policy and clockUnit. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**dayIn / dayNotIn**  
Weekday-list date operators, computed in the evaluation time zone. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**delegate**  
The Prisma model delegates executePrismaPlan queries, e.g. `{ post: prisma.post }` or the client. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**describeRule**  
`{ sources, bridgesCrossed, supportedTargets, errors }` for routing and UX, not the gate. *Region:* [Using a lens](using-a-lens/knowledge.md)

**describeValue**  
Type, paths read, clock unit and every issue for a value expression under a lens, without throwing. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**distinct**  
Value mode listing values without repeats, first seen first, NULLs skipped; never a comparison. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

## E

**EdgeExpr**  
`{ start: period }` / `{ end: period }`: a named edge of a calendar period. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**eligibility**  
The source's where: which rows' values are offered. *Region:* [Field option sources](option-sources/knowledge.md)

**endpoint**  
One side of a bridge: which map, which model, and the `on` join field. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**engine-design-rules**  
Class: CLAUDE.md's standing rulings and the verification routine. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**engine-globals**  
Class: engineGlobals process-wide defaults, with(), reset() and registerEngineGlobals. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**engineGlobals**  
Process-wide defaults keyed by dotted path, typed per path (EngineGlobalPath, EngineGlobalValues). *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**engineGlobals.with**  
Merge overrides for one synchronous callback, restoring on return or throw. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**enum registry**  
A FieldMap's `enums`: enum type name to its allowed values. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**EnumNarrowing**  
`{ picks?, omits? }` narrowing an enum type across a map. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**enumPicks / enumOmits**  
Per-field enum allow-list / deny-list. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**error**  
A rule's own failure message key; otherwise a generated message. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**evaluateValue**  
Compute a value expression from a row in memory, with check's options. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**everything serializable**  
Public inputs and outputs are plain JSON: no Sets, callbacks or functions. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**executePrismaPlan**  
Run a plan's steps against Prisma delegates and return the final resolved where. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**EXISTS / NOT EXISTS**  
How toWhereSql compiles any / notEmpty and none / empty / all on a to-many relation. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**extremal window**  
The take: 1 orderBy window toPrisma compiles; otherwise only a filter alone. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

## F

**fan-out**  
A joined to-many relation repeats the parent per related row: count distinct. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**field rule**  
`{ field, operator, value }`: compare one field with a value. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**{ __field } sentinel**  
A toPrisma column reference that executePrismaPlan resolves to `prisma.<model>.fields.<column>`. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**field-maps-and-bridges**  
This region's class: FieldMap / FieldMapSet / Bridge schema and the stitch, index, validate and walk helpers. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**FieldKind**  
String, Boolean, Int, BigInt, Float, Decimal, DateTime, Json, Bytes, Enum. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**FieldMap**  
`{ models, enums? }`: one source's models keyed by name plus its enum registry. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**FieldMapEntry**  
One field's description: kind, type, isRequired, values, options, relation keys. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**FieldMapEntry.values**  
A field's own enum base set (replaces the registry); projectLens writes the resolved allowed set there. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**FieldMapSet**  
`{ maps, bridges }`: named FieldMaps plus the cross-source edges between them. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**filter-first all**  
Under arrayOperator all the clamp goes into the array rule's window `filter`, so out-of-scope rows are dropped before the check. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**filter-first all**  
Under arrayOperator all (and on a windowed node, or one with no condition), the clamp becomes the window filter, so out-of-scope rows drop before all runs. *Region:* [Using a lens](using-a-lens/knowledge.md)

**first narrowing**  
The layer directly over the base lens: the only one that turns relations on and whose where reads any schema relation. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**from: 'mapDefaults'**  
A pointer source that takes the model's own source from mapDefaults, offering unlinked rows too. *Region:* [Field option sources](option-sources/knowledge.md)

## G

**getConditionShapeKeys**  
Public: the required and optional keys of one ConditionShape. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**getLensRoot**  
The base lens a narrowing chain is rooted at; throws on a cyclic chain or a narrowing that carries a base-lens key (model / maps). *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**getOperatorsForKind**  
`{ field, date }` operators a FieldKind takes, optionally per target. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**groupBy**  
Axes that group a source's options (SourceOption `groups`). *Region:* [Field option sources](option-sources/knowledge.md)

**groupBy step**  
A countStep or groupStep that groups child rows to filter parents by counts or sums; executePrismaPlan runs it. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

## H

**holdsOnNoRows**  
Operator catalog fact (empty, none, all, counts) that join mode refuses. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

## I

**if / then / else**  
Apply `then` when `if` holds, else `else`. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**in-memory-evaluator**  
Class: check(rule, data, options) returning true or a failure message. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**indexBridges**  
Index raw rows by map, model, `on` field and value, for embedding under bridge keys. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**inferValueType**  
A value expression's `{ kind, isList, nullable }`; throws when it has no type. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**inline-predicates**  
This region's class: toWhereSql, toLensWhereSql, SqlDialect and the join-mode rules. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**Invalid date value**  
Compiler error for an '' rule date; check() says 'Invalid comparison date'. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**invalid_field_name**  
validateFieldMaps' code for a field name with a path step or bridge marker. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**invalid_source**  
validateNarrowing code for a pointer whose model declares no source. *Region:* [Field option sources](option-sources/knowledge.md)

**invalid_value_source**  
Issue for a bare value `path` in any clamp but `root.where`. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**IS [NOT] DISTINCT FROM**  
toSql's NULL-safe equals / notEquals for a column path compare. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**isRequired**  
FieldMapEntry flag; `false` licenses toPrisma's NULL and optional-hop arms. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**isRequired: false**  
FieldMapEntry flag that licenses toPrisma's NULL and hop arms; without it the bare not / notIn is emitted. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

## J

**joins**  
toSql's LEFT JOIN strings for relation paths, emitted with { map, model }. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**Json boundary**  
Path resolution stops at a Json column; sub-paths below are accepted unchecked. *Region:* [Using a lens](using-a-lens/knowledge.md)

**Json by type**  
A Json column or dotted path compares as jsonb, typed as check() reads it. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**Json filter mapping**  
contains to string_contains OR array_contains, startsWith / endsWith to string_starts_with / string_ends_with, in to one equals per value. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

## K

**keepClampColumns**  
projectRows option keeping clamp-read columns for a re-check; never returned to a viewer. *Region:* [Using a lens](using-a-lens/knowledge.md)

**kind: 'bridge'**  
The FieldMapEntry kind stitchFieldMaps injects on each endpoint model. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**kind: 'object'**  
A relation field within one map (to-one or, with isList, to-many). *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

## L

**label**  
A column read as each option's display label; a value takes its least label. *Region:* [Field option sources](option-sources/knowledge.md)

**layer**  
One LensNarrowing with a `parent` (the base Lens or another narrowing); layers only narrow. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**layer guard**  
Join mode throws when a joined relation's clamp sits in the reading where's layer or later. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**leak-safe surface**  
`projectLens(…, { by: 'model' })`: a Lens with where dropped and only exposed fields and enum values. *Region:* [Using a lens](using-a-lens/knowledge.md)

**Lens**  
A FieldMapSet anchored at `(mapName, model)`; schema only, no data on it. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**lens option**  
`{ lens }` instead of map / mapName / model: gate, narrow, then compile; never both. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**{ lens } compile**  
`toPrisma(rule, { lens })` / `toSql(rule, { lens })`: gate, narrow and compile against the base lens in one call. *Region:* [Using a lens](using-a-lens/knowledge.md)

**lens-gate-and-compiles**  
Class: gating, narrowing, describing, coercing and compiling a rule under a lens. *Region:* [Using a lens](using-a-lens/knowledge.md)

**lens-layers-and-clamps**  
This class: how LensNarrowing layers stack and how their where clamps compose and anchor. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**lens-narrowing**  
This region's class: createLens and the shape of one LensNarrowing layer. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**lens-projection-and-fetch**  
Class: projecting, walking, reading and fetching what a lens shows. *Region:* [Using a lens](using-a-lens/knowledge.md)

**LensNarrowing**  
`{ parent, root?, mapDefaults? }`: one layer that only narrows its parent. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**LensRefusal**  
Error (with a `code`) raised when the lens cannot apply a narrowing, clamp or source. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**LensRefusal**  
Thrown when a clamp can't be carried down a source's path (e.g. no inverse relation). *Region:* [Field option sources](option-sources/knowledge.md)

**LensRefusal**  
Error class (with `code`) for what the lens itself can't do. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**LensRefusal**  
Error thrown by narrowRule and { lens } compiles for what the lens can't do; carries a code. *Region:* [Using a lens](using-a-lens/knowledge.md)

**lensVisit**  
One visit as projectLens gives it at a relation path, resolved on demand; null if not shown. *Region:* [Using a lens](using-a-lens/knowledge.md)

**listBindings**  
Sorted bind names a rule reads; `{ required: true }` for those a bindings map must cover. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**listFields**  
The row paths a rule reads, so a hydrator can load them before check(). *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

## M

**map / model / mapName**  
The FieldMap (or FieldMapSet plus mapName) and root model; required for counts, aggregates and column compares. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**mapCondition**  
Internal: rewrite a condition tree node by node, scoping nested conditions. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**mapDefaults**  
Per-map NarrowingDefaults applied wherever a model or enum type appears in that map. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**mapDefaults[X].models[M].where**  
Model-intrinsic clamp, injected at every visit of model M in map X (soft-delete everywhere). *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**mapName**  
Names which map of a FieldMapSet (or lens) to read; required when map is a set. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**matchAll**  
Function returning `{}`, the where that matches every row. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**matchNothing**  
Function returning `{ OR: [] }`, the where that matches no row. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**mode: 'insensitive'**  
Added for caseInsensitive on providers that take it (PostgreSQL, CockroachDB, MongoDB). *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**model-default tree**  
Model-default turn-ons followed breadth-first, each model once at its nearest reach. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**ModelDefaultNarrowing**  
picks, omits, enumPicks, enumOmits, where, sources, relations for a model; ModelNarrowing is the same shape on a path. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**modelOf / fieldOf**  
Internal own-property readers of a map's model and field entries. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

## N

**naive datetime**  
A zoneless string (date-only is midnight) read in the resolved evaluation time zone, never host-local. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**NarrowingDefaults**  
`{ models?, enums? }`: one map's applies-everywhere narrowings. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**narrowRule**  
Inject a lens's where clamps into a rule at the root and each relation it enters. *Region:* [Using a lens](using-a-lens/knowledge.md)

**negation**  
notEquals, notIn, notContains, notMatches, notBetween and the like: the complement of the positive form. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**negative-flavored date operators**  
notBefore, notAfter, notWithin, notBetween, dayNotIn: a NULL date matches. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**not_in_lens**  
Gate code for a field or relation the lens does not show. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**not_visible**  
validateNarrowing code: a layer names an item an ancestor hid, or a relation the parent doesn't show. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**now**  
The explicit anchor instant; required whenever a relative or period expression is present. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**now**  
Explicit instant toPrisma needs for relative dates; there is no wall-clock fallback. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**NULL arm**  
The `OR col IS NULL` (SQL) or `{ col: { equals: null } }` (Prisma) a compiler adds so a negation keeps NULL rows. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**null-semantics**  
This region's class: negations and negative date operators keep NULL rows on every rail; avg of nothing is NULL. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

## O

**offset**  
A value source that moves the comparison value: a number on a field rule, a rolling shift on a date rule. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**omits**  
Drop these fields; may name a relation to hide it. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**on**  
The symmetric join field of a bridge endpoint; must be unique on the one side. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**Operator**  
Runtime const object of field operators (equals, notEquals, lessThan, contains, in, between, matches, exists, …). *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**operator-catalog**  
Class: the one table of operators per field kind and target (getOperatorsForKind, getValueShape, FieldKind, RuleTarget). *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**option-sources**  
This region's class: field option sources and the functions that turn them into option sets. *Region:* [Field option sources](option-sources/knowledge.md)

**optional to-one hop**  
A relation with isRequired: false on the path; negations add `{ rel: { is: null } }` for it. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**OrderBy**  
`[{ field, dir: 'asc' | 'desc' }]`; NULLs sort last in both directions. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**orderRecords**  
Sort records by an OrderBy exactly as every rail orders a window. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**orWhere**  
OR compiled wheres; match-all absorbs, match-nothing drops out. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**over-fetch**  
Reads across a bridge compile to TRUE so the local query never pre-filters on what it can't see. *Region:* [Field option sources](option-sources/knowledge.md)

**own-property lookup**  
`Object.hasOwn(map, key)`, never `key in map`, so `toString` never resolves from the prototype. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**owner module**  
The only module allowed to implement an internal verb (e.g. src/own.ts for field-map reads). *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

## P

**params**  
toSql's ordered values for `$1`, `$2`, …; no value is inlined. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**parent**  
The Lens or LensNarrowing a layer narrows. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**parent's projection**  
What the parent layer shows; a layer may only mention (pick, omit, turn on, clamp) that. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**parent:name**  
A later layer reading the bind its ancestor declares. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**parseScopeRef**  
Split a `$` ref into `{ depth, path }`, null for a bare ref. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**path**  
Compare with another value on the row; a bare path reads the root row. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**path source**  
A source declared down a relation path; offers only the rows reachable from there. *Region:* [Field option sources](option-sources/knowledge.md)

**PeriodExpr**  
`{ this | last | next: unit }` naming a calendar period (day, week, isoWeek, month, quarter, year, hour, minute, second). *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**PGlite differential test**  
A test comparing check() with executed SQL in PGlite, required for cross-rail changes. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**picks**  
Keep only these columns; names columns only (a relation is `wrong_kind`). *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**plan**  
toPrisma's result `{ steps }`; read `plan.steps.at(-1).where` only when no groupBy steps or column refs. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**positive date operators**  
before, after, between, within, dayIn, …: a NULL date never matches. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**Postgres interval order**  
Units apply months, then days, then time, so every rail lands on the same instant across month ends and DST. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**posture**  
A way of using the lens (reason, fetch, read); all pass through every layer. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**prefixConditionFields**  
Re-root a condition onto a related record by prefixing its paths; refuses shapes it can't move. *Region:* [Using a lens](using-a-lens/knowledge.md)

**Prisma Limitations**  
README list of shapes toPrisma refuses: matches, dayIn, $$ refs, stored-array aggregates, scalar-list element conditions. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**prisma-plan-execution**  
This region's class: executePrismaPlan and the where composers andWhere / orWhere / matchAll / matchNothing. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**prisma-planner**  
This region's class: toPrisma and the rules for what it emits. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**prismaOptions.datasource.provider**  
Prisma connector (default 'postgresql') deciding whether mode: 'insensitive' is emitted. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**ProjectedVisit**  
One path's resolved view: mapName, model, fields, whereClauses, sources, sourceLabels, sourceGroupBys, sourceFrom. *Region:* [Using a lens](using-a-lens/knowledge.md)

**projectLens**  
What a lens exposes: by path (a Projection of ProjectedVisits) or `{ by: 'model' }` (a Lens). *Region:* [Using a lens](using-a-lens/knowledge.md)

**projectRows**  
Cut fetched rows to what a lens shows: hidden columns, off relations and hidden rows removed. *Region:* [Using a lens](using-a-lens/knowledge.md)

**pure intersection**  
Composition rule: picks intersect, omits union, enumPicks intersect, enumOmits union, wheres AND. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

## Q

**quoteField**  
Internal toSql helper that quotes a column and Json sub-path; not importable. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

## R

**rail**  
One of the three backends: check() in memory, toPrisma(), toSql(). *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**rail-support**  
This region's class: which rail compiles which rule shape, per-rail limits, and where rails differ. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**readLensValue**  
One value off a row as the lens shows it; `{ ok, value }` or `{ ok: false, reason }`. *Region:* [Using a lens](using-a-lens/knowledge.md)

**readScopeRef**  
Pick the scope a ref names from a stack and the path left; returns `{ outOfBounds }` instead of throwing. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**recheck**  
The part of a bridged source the database could not decide; when present the query's rows are candidates. *Region:* [Field option sources](option-sources/knowledge.md)

**registerEngineGlobals**  
Add a library's own one-segment namespace with defaults. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**relation list**  
A to-many relation field; counts and sums over it compile to groupBy steps. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**relation object**  
`relations.org = { where, picks, omits, relations }`: turns a relation on and narrows that hop. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**relationKeys**  
Internal helper giving a relation's column pairs; app code declares relations in the FieldMap. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**relationKeys**  
The map's relation key pairs that key each EXISTS subquery or LEFT JOIN ON. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**relations off by default**  
A relation is hidden until the first narrowing turns it on; off is `not_in_lens` / `hidden` everywhere. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**resolveDateConfig**  
Internal single resolver of one evaluation's zone (name, `{ value }` / `{ bind }`, else 'UTC'); not importable. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**ResolvedDateConfig**  
The date-expression layer's config, whose zone is a plain string. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**RollingExpr**  
`{ ago: { days: 30 } }` or `{ ahead: { months: 2 } }`; a point, or with within a window [now-Δ, now] / [now, now+Δ]. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**root**  
Path-specific ModelNarrowing at the anchor visit; descends via `relations`. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**root index.ts**  
The one package entry; names every export (src/*/index.ts are internal barrels). *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**root-array rule**  
A fieldless arrayOperator rule over an array of anchor rows, for batch evaluation across bridges. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**root-array rule**  
An all / any tree of fieldless array rules over array data; check()-only. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**root.relations**  
Narrowing (and turn-on) only along a spelled relation path. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**root.relations[R].where**  
Path-specific clamp, applied only when a rule descends through relation R. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**root.where**  
Clamp at the lens anchor visit; the home for scoping the lens's root model. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**rowShape**  
materializeSourceQuery option: 'prisma' (nested label/axes, default) or 'sql' (flat __label / __group_i). *Region:* [Field option sources](option-sources/knowledge.md)

**rule-ast**  
Class: the Condition grammar, its operator enums and Condition / Strict* types. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**rule-validation**  
Class: validateRule / assertValidRule with coded issues, UsageError vs LensRefusal vs plain Error. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**RuleTarget**  
check, toPrisma, toSql: where a rule runs. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

## S

**schema narrowing**  
picks/omits/enum narrowing: what is visible and mentionable. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**$$. scope ref**  
A reference to an enclosing array element; check() only. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**scope ref**  
`$.` the current array element, `$$.` the enclosing element, `$$$.` the one above; only array and aggregate rules add a level. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**scope_out_of_bounds**  
A clamp's scope ref climbs out of the clamp's own row. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**scope_out_of_bounds**  
validateRule's issue for a ref deeper than the nesting; check() throws on it. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**someCondition**  
Internal: short-circuit test whether any node satisfies a predicate. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**SourceEntry**  
A `sources` entry: a Condition, `{ where?, label?, groupBy? }`, or `{ from: 'mapDefaults' }` on a path. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**SourceOption**  
One offered value, with an optional label and groups. *Region:* [Field option sources](option-sources/knowledge.md)

**SourceOptionOrder**  
Runtime const and type: value (default, sorted) or query (keep the query's order). *Region:* [Field option sources](option-sources/knowledge.md)

**SourceQuery**  
toSourceQueries' output per sourced field: { path, mapName, model, field, label?, groupBy?, composedWhere, prisma, sql, recheck? }. *Region:* [Field option sources](option-sources/knowledge.md)

**sources**  
A narrowing node's per-field map of where its selectable values come from. *Region:* [Field option sources](option-sources/knowledge.md)

**SourceSpec**  
A source declaration `{ where?, label?, groupBy? }`, or `{ from: 'mapDefaults', where? }` to offer the model default's source; a bare Condition is the eligibility-only form. *Region:* [Field option sources](option-sources/knowledge.md)

**SourceValues**  
One field's option set: { path, mapName, model, field, options: [{ value, label?, groups? }] }. *Region:* [Field option sources](option-sources/knowledge.md)

**sourceValues**  
projectLens option that attaches materialized SourceValues to fields as `options`. *Region:* [Field option sources](option-sources/knowledge.md)

**SQL Limitations**  
README list: toSql compiles no array element operators and yields WHERE fragments plus LEFT JOINs. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**sql-compiler**  
This region's class: toSql and its rules, the parameterized PostgreSQL rail. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**sql.dialect**  
The SqlDialect (postgres or mysql) toWhereSql and toLensWhereSql write. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**sql.dialect**  
The engine global toWhereSql and toLensWhereSql read; toSql ignores it. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**SqlDialect**  
Runtime const and type: postgres (default) or mysql. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**src/lens/policy.ts**  
Internal home of the per-visit policy (resolveVisit, clamp checks) and LensRefusal. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**stitchFieldMaps**  
Copy a FieldMapSet with a bridge field added to each endpoint model. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**storage-aware arrays**  
With a map, toSql compiles a list as native (cardinality, unnest) or Json (jsonb_array_length). *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**StoredLens**  
The serializable record of one layer, with the ids of its parents. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**storeLens**  
Writes a composed lens as one StoredLens record per layer, base first. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**StrictCondition**  
Strict rule types pairing each operator with its operand's type. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**string.fuzzy**  
Default typo-tolerant contains / notContains; the compilers refuse those while it is on. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**structural-walk**  
Class: src/traverse.ts as the single condition-tree walk and its value-side helpers. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**sum of nothing**  
0 on every rail, so a comparison that holds at 0 keeps empty parents. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**supportedTargets**  
Which of check / toPrisma / toSql can run a rule, by its shape. *Region:* [Using a lens](using-a-lens/knowledge.md)

## T

**tables**  
Map from a to-many relation path to the table text after FROM in its EXISTS subquery. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**test/verbs.test.ts**  
Enforces owners, VERBS.md coverage of exported functions, no export *, no resolve* names. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**timeZone**  
Option (default 'UTC') localizing now, period edges, naive strings and weekdays; TimeZoneConfig is `string | ValueSourceOf<string>`. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**toLensSelect**  
Prisma findMany `{ select }` for what a lens shows, to-many clamps as relation wheres. *Region:* [Using a lens](using-a-lens/knowledge.md)

**toLensWhereSql**  
Write a lens's wheres as inline predicates: `{ root, relations, mapDefaults }`. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**toMany**  
toLensWhereSql option: 'subquery' (EXISTS, the default) or 'join' (read the caller's LEFT JOIN). *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**toMany: 'join'**  
Join mode: only notEmpty and one any(cond) per relation, in the root where only. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**toPrisma**  
Compile a rule into a Prisma plan `{ steps }` ending in a where step. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**toSql**  
Compile a rule to `{ sql, params, joins }`: a PostgreSQL WHERE fragment, its parameters and LEFT JOINs. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

**toWhereSql**  
Write a condition as an inline-value predicate over the caller's columns, in the engine's sql.dialect. *Region:* [SQL compilers and inline predicates](sql-rails/knowledge.md)

## U

**unit amount**  
A relative unit given as a number or a value source (`{ path }`, `{ bind }`, `{ value }`). *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**Unresolved binding**  
The compilers' error for a required timeZone `{ bind }` left unbound; bindRule first. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**UsageError**  
Thrown for a missing or invalid `now` or time zone: the caller's input. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**UsageError**  
Error class for the caller's input missing or malformed (no now, bad zone, unbound bind). *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**UsageError**  
Thrown when fetched rows lack a key a source or clamp reads, or a recheck is materialized without a lens. *Region:* [Field option sources](option-sources/knowledge.md)

**UsageError**  
Error class for the caller's missing or malformed input. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

## V

**validateFieldMaps**  
Return `{ ok, errors }` for field names holding `.` or `:` (code invalid_field_name). *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**validateNarrowing**  
Returns `{ ok, errors }` with coded issues for a layer against the layers above it. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**validateRule**  
Check a rule's shape and target support without data; returns `{ ok, errors }`. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**validateRuleInLens**  
The security gate: `{ ok, errors }` for every field, ref, operator and value a rule uses; reports rule problems as issues, not throws (a malformed lens chain still throws). *Region:* [Using a lens](using-a-lens/knowledge.md)

**validateValue / assertValidValue**  
Shape check of a value expression without data: `{ ok, errors }` or throw. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**ValidationIssue**  
A coded issue `{ path, code, message }` from validateRule. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**value expression**  
A literal, source, aggregate without comparison, if / then / else or list that computes a value. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**value source**  
One of `{ value }`, `{ path }` or `{ bind }` (with bindOptional), read with the same contract in every value slot. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**value-expressions**  
Class: computed values with evaluateValue and their checks (validateValue, inferValueType, describeValue, coerceValue, valueClockUnit). *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**value-side refs**  
Paths a leaf reads on its value side (valueRefs / valueRefRoles), distinct from its field. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**value-sources-and-scope**  
Class: where a compared value comes from — literal, `{ path }`, scope refs, offsets and unit amounts. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**VALUE_AGGREGATE_MODES**  
sum, avg, count, min, max, distinct. *Region:* [Value sources, bindings, value expressions](values-and-bindings/knowledge.md)

**valueClockUnit**  
clockUnit for a value expression, over every condition it holds. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**ValueShape**  
The operand an operator takes: none, scalar, ordered, range, dayList, count, … *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**verb-catalog**  
Class: docs/VERBS.md's one verb, one name, one owner rule, enforced by test/verbs.test.ts. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**VERBS.md**  
docs/VERBS.md: the public verb table and the internal verbs with their owning modules. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

**visitCondition**  
Internal: walk every node of a condition tree with its scope. *Region:* [Engine architecture and globals](engine-architecture/knowledge.md)

## W

**walkFieldPath**  
Internal: walk a dotted field path through a map hop by hop; app code uses walkLensPath. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**walkLensPath**  
Resolve one dotted path through a lens: resolved (hops, terminal, jsonSubPath) or hidden / missing / pastScalar. *Region:* [Using a lens](using-a-lens/knowledge.md)

**walkMaps**  
Internal low-level step-through under walkFieldPath and the lens path resolvers. *Region:* [Field maps and bridges](field-maps-and-bridges/knowledge.md)

**weekStart**  
Option (default 'monday') setting where a week begins for this / last / next. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**where**  
Data narrowing: a Condition clamp; only rows satisfying it are admitted (filter-first). *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)

**where step**  
`{ operation: 'where', where }`, the final step of every plan. *Region:* [Prisma rail: plans and wheres](prisma-rail/knowledge.md)

**Where the Rails Differ**  
README list of accepted engine gaps: case mapping, string order, non-array Json, numeric strings, double vs numeric. *Region:* [Rail parity and NULL rows](rail-parity-and-nulls/knowledge.md)

**window**  
`filter`, `orderBy`, `skip`, `take` on an array or aggregate rule, applied before the predicate. *Region:* [Rule grammar, check and validation](rule-grammar-and-check/knowledge.md)

**window filter**  
The array rule's `filter`, applied before orderBy / take / skip and before the condition. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**within / notWithin**  
Range date operators for period and rolling expressions; notWithin also matches a never-set date. *Region:* [Dates, time zones and the clock](dates-and-clock/knowledge.md)

**wrong_kind**  
validateNarrowing code: e.g. a relation named in `picks`. *Region:* [Lens layers and clamps](lens-layers-and-clamps/knowledge.md)

**wrong_kind**  
Issue code for a relation named in picks. *Region:* [Lens narrowing shape](lens-narrowing/knowledge.md)
