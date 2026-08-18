import type { Condition } from '../types';
import { buildCondition } from './condition';
import type { BuildOptions, FieldMap, PrismaBuildState, ToPrismaResult } from './types';

// gloss
const normalizeOptions = (options?: BuildOptions): BuildOptions | undefined => {
  if (!options?.map) return options;
  const mapIsSet = 'maps' in options.map;
  // why: a FieldMapSet without mapName would pass through as a FieldMap — silently losing map-awareness
  if (mapIsSet && !options.mapName) {
    throw new Error(
      `toPrisma: 'map' is a FieldMapSet — 'mapName' is required to resolve which map to use.`,
    );
  }
  if (!mapIsSet || !options.mapName) return options;
  const resolved = (options.map as { maps: Record<string, FieldMap> }).maps[options.mapName];
  if (!resolved) {
    throw new Error(`toPrisma: fieldMap set has no entry for '${options.mapName}'`);
  }
  return { ...options, map: resolved };
};

export { executePrismaQueryPlan } from './execute';
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
} from './types';

// gloss
export const toPrisma = (condition: Condition, options?: BuildOptions): ToPrismaResult => {
  const state: PrismaBuildState = { steps: [] };
  const where = buildCondition(condition, normalizeOptions(options), state);
  return {
    steps: [...state.steps, { operation: 'where', where }],
  };
};
