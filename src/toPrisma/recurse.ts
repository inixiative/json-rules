import type { Condition } from '../types';
import type { BuildOptions, PrismaBuildState, PrismaWhere } from './types';

// The rail's one recursion point: sub-builders compile their child conditions through it, and
// condition.ts installs the dispatcher — so no builder imports the dispatcher it is part of.

type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;

let dispatch: BuildConditionFn;

export const setConditionBuilder = (fn: BuildConditionFn): void => {
  dispatch = fn;
};

export const buildCondition: BuildConditionFn = (condition, options, state) =>
  dispatch(condition, options, state);
