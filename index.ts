// The public API: one name per operation, grouped by verb in docs/VERBS.md.

export { bindRule, listBindings } from './src/bindings';
export { type CheckOptions, check } from './src/check';
export {
  type EngineGlobalsState,
  engineGlobals,
  type PrismaProvider,
} from './src/engineGlobals';
export {
  assertValidFieldMaps,
  type Bridge,
  type BridgeCardinality,
  type BridgeDictionary,
  type BridgeEndpoint,
  type FieldMapSet,
  indexBridges,
  stitchFieldMaps,
  validateFieldMaps,
} from './src/fieldMap';
export type { FuzzyConfig } from './src/fuzzy';
export type {
  EnumNarrowing,
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  NarrowingDefaults,
  SourceSpec,
  SourceValue,
} from './src/lens';
export {
  assertValidNarrowing,
  bindLens,
  type CreateLensInput,
  coerceRule,
  createLens,
  describeRule,
  describeRuleSources,
  type LensPathHop,
  type LensPathResolution,
  listLensBindings,
  materializeSourceQuery,
  materializeSources,
  narrowRule,
  type PathProjection,
  type ProjectedVisit,
  type ProjectOptions,
  projectLens,
  type RuleDescription,
  type RuleSourceValues,
  type SourcePrismaQuery,
  type SourceQuery,
  type SourceRowShape,
  type SourceSqlQuery,
  type SourceValues,
  toSourceQueries,
  validateNarrowing,
  validateRuleInLens,
  walkLensPath,
} from './src/lens';
export { ArrayOperator, DateOperator, Operator } from './src/operator';
export {
  ALL_KINDS,
  FieldKind,
  getAggregateOperators,
  getArrayOperators,
  getOperatorsForKind,
  getValueShape,
  NUMERIC_KINDS,
  type OperatorFamily,
  RuleTarget,
  ValueShape,
} from './src/operatorCatalog';
export {
  parseScopeRef,
  readScopeRef,
  type ScopedRef,
  type ScopeOutOfBounds,
  type ScopeRef,
} from './src/scope';
export type {
  BuildOptions,
  FieldMap,
  FieldMapEntry,
  GroupByStep,
  PrismaStep,
  PrismaWhere,
  SourceOption,
  StepRef,
  ToPrismaResult,
  WhereStep,
} from './src/toPrisma';
export { executePrismaPlan, toPrisma } from './src/toPrisma';
export { type SqlBuildOptions, type SqlResult, toSql } from './src/toSql';
export type * from './src/types';
export {
  assertValidRule,
  type ValidationIssue,
  type ValidationResult,
  validateRule,
} from './src/validate';
