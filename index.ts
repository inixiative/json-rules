// The public API: one name per operation, grouped by verb in docs/VERBS.md.

export { bindRule, type ListBindingsOptions, listBindings } from './src/bindings';
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
  type FieldMap,
  type FieldMapEntry,
  type FieldMapSet,
  indexBridges,
  type ModelEntry,
  type SourceOption,
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
  SourceEntry,
  SourceSpec,
} from './src/lens';
export {
  assertValidNarrowing,
  bindLens,
  coerceRule,
  createLens,
  describeRule,
  describeRuleSources,
  type LensPathHop,
  type LensPathResolution,
  listLensBindings,
  type MaterializeSourceQueryOptions,
  materializeSourceQuery,
  materializeSources,
  narrowRule,
  type PathProjection,
  type ProjectedVisit,
  type ProjectLensOptions,
  projectLens,
  type RuleDescription,
  type RuleSourceDescription,
  type SourcePrismaQuery,
  type SourceQuery,
  type SourceRowShape,
  type SourceSelect,
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
  GroupByStep,
  PrismaStep,
  PrismaWhere,
  StepRef,
  ToPrismaOptions,
  ToPrismaResult,
  WhereStep,
} from './src/toPrisma';
export { executePrismaPlan, toPrisma } from './src/toPrisma';
export { type ToSqlOptions, type ToSqlResult, toSql } from './src/toSql';
export type * from './src/types';
export {
  assertValidRule,
  type ValidateRuleOptions,
  type ValidationIssue,
  type ValidationResult,
  validateRule,
} from './src/validate';
