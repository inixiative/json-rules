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
| traverse a condition tree | `src/traverse.ts` (`visitCondition`, `someCondition`, `mapCondition`, `mapLeafSources`) | No `'all' in` / `.all.map(` descent elsewhere — except the evaluators and compilers, whose descent is their semantics. |
| read a field-map record | `src/own.ts` (`own`, `modelOf`, `fieldOf`) | No `.models[` / `.fields[` / `.maps[` read elsewhere: own-property only. |
| read a path | `src/scope.ts` (`readOwnPath`, `readPath`, `readContextRef`) | No lodash `get` (it reads `Object.prototype`). |
| read a value source | `src/valueSource.ts` (`matchSource`), one reader per rail | — |
| read a binding | `src/valueSource.ts` (`readBinding`, `compileBinding`) | `Object.hasOwn(bindings` only in the bind modules. |
| walk a field path | `src/toPrisma/mapWalk.ts` (`walkFieldPath`); the lens's `src/lens/policy.ts` (`resolvePolicyPath`, `relationHops`) | No hand-split path walked against a map elsewhere. |
| define an operator, kind or unit set | `src/operatorCatalog.ts` | No list of operators elsewhere. |
| default the time zone | `src/dateExpr.ts` (`DEFAULT_ZONE`) | `'UTC'` nowhere else. |
| parse a date | `src/date.ts` (`parseDateValue`, `coerceDateLiteral`) | No `Date.parse` / `dayjs.tz` elsewhere. |
| shape a rolling expression | `src/dateExpr.ts` (`rollingShift`, `rollingExpr`) | No `'ago' in` / `{ ago: … }` elsewhere. |
| compare (SQL) | `src/toSql/compare.ts` | — |
| offset | `src/offset.ts`, one module per rail | — |

Public names never start with `resolve`: it named five different verbs before 3.0.
