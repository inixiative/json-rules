# Verbs

Every operation json-rules performs has one verb, one public name per thing it applies to, and
one implementation. `test/verbs.test.ts` enforces it: each internal verb below names the only
modules allowed to implement it, and every exported function must appear in this file.

## Public API

| Verb | Name | What it does |
| --- | --- | --- |
| evaluate | `check` | Evaluate a rule against data. |
| compile | `toSql`, `toPrisma` | Compile a rule to a SQL WHERE, or a Prisma query plan. |
| compile | `toSourceQueries` | Compile a lens's sources to option queries (Prisma and SQL). |
| execute | `executePrismaPlan` | Run a Prisma query plan's steps and return its final WHERE. |
| validate | `validateRule`, `validateRuleInLens`, `validateNarrowing`, `validateFieldMaps` | Return `{ ok, errors: { path, message, code }[] }`. |
| validate | `assertValidRule`, `assertValidNarrowing`, `assertValidFieldMaps` | The throwing form of each validator. |
| bind | `bindRule`, `bindLens` | Substitute supplied bindings into a rule, or a lens's narrowing conditions. |
| bind | `listBindings`, `listLensBindings` | The bind names a rule or lens reads, sorted (`{ required }` drops `bindOptional`). |
| narrow | `narrowRule` | Inject a lens's grants into a rule at their anchors. |
| coerce | `coerceRule` | Stamp each field rule with its field's `coerceType` from the lens. |
| project | `projectLens` | What a lens exposes: by declared path (`by: 'path'`), or flattened into a Lens (`by: 'model'`). |
| walk | `walkLensPath` | Resolve a dotted path through a lens, hop by hop. |
| describe | `describeRule` | A rule's sources, bridge crossings and compile targets under a lens. |
| describe | `describeRuleSources` | The literal values a rule names at each source the lens declares. |
| materialize | `materializeSources`, `materializeSourceQuery` | Turn fetched rows into source option sets. |
| create | `createLens` | Build a lens from field maps and bridges. |
| store | `storeLens` | A composed lens as the records it's stored in: one per layer, each listing the ids it composes with (the base lens first). |
| compose | `composeLens` | A stored layer and the records it lists, resolved into the composed lens every other function takes. |
| stitch | `stitchFieldMaps` | Join field maps across bridges. |
| index | `indexBridges` | Key a set of bridges by endpoint. |
| read | `parseScopeRef`, `readScopeRef` | Parse a `$`-prefixed ref; read which scope it names. |
| look up | `getOperatorsForKind`, `getArrayOperators`, `getAggregateOperators`, `getValueShape` | Read the operator catalog. |

`engineGlobals` (configure) holds process-wide defaults; `Operator`, `DateOperator`,
`ArrayOperator`, `FieldKind`, `RuleTarget`, `ValueShape`, `NUMERIC_KINDS` and `ALL_KINDS` are
the catalog's constants.

## Internal verbs and their owners

| Verb | Owner | Rule (`test/verbs.test.ts`) |
| --- | --- | --- |
| traverse a condition tree | `src/traverse.ts` (`visitCondition`, `someCondition`, `mapCondition`, `elementRefs`, `valueRefs`) | No `'all' in` / `.all.map(` descent elsewhere — except the evaluators and compilers, whose descent is their semantics. |
| read a field-map record | `src/own.ts` (`own`, `modelOf`, `fieldOf`) | No `.models[` / `.fields[` / `.maps[` read elsewhere: own-property only. |
| read a path, a row by key | `src/scope.ts` (`readOwnPath`, `readPath`) | No lodash `get` / `has` / `keyBy` / `groupBy` / `property` anywhere: they read `Object.prototype`. |
| read a binding | `src/valueSource.ts`, `src/bindings.ts` | `Object.hasOwn(bindings` only there. |
| walk a field path | `src/fieldMap/walk.ts` (`walkMaps`, under `walkFieldPath`, the lens's `resolvePolicyPath` and `relationHops`) | No hand-split path walked against a map elsewhere. |
| classify a field-map entry | `src/fieldMap/entry.ts` (`isJsonEntry`, `isRelationEntry`, `declaredEnumValues`) | No `kind === 'object' \|\| … 'bridge'` (or its negation) elsewhere. |
| name a bridge endpoint | `src/fieldMap/endpointKey.ts` | `map:Model` built nowhere else. |
| define an operator, kind or unit set | `src/operatorCatalog.ts` | No list of operators (enum or string) elsewhere; the catalog tables read nowhere else. |
| recurse into a child condition | `src/toSql/recurse.ts`, `src/toPrisma/recurse.ts` | One forward declaration per rail. |
| build a Prisma logical constant | `src/toPrisma/logical.ts` | — |
| default the time zone | `src/dateExpr.ts` (`DEFAULT_ZONE`) | `'UTC'` nowhere else. |
| parse a date | `src/date.ts`, `src/dateExpr.ts` | No `Date.parse` / `dayjs.tz` elsewhere. |
| shape a rolling expression | `src/dateExpr.ts` (`rollingShift`, `rollingExpr`), `src/types.ts` | No `'ago' in` / `{ ago: … }` elsewhere. |
| re-export a module | — | No `export * from`: every public name is listed. |
| compare (SQL) | `src/toSql/compare.ts` | — |
| offset | `src/offset.ts`, one module per rail | — |

Public names never start with `resolve`: it named five different verbs before 3.0.
