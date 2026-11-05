import { clockUnit } from '../clock';
import { type LensRead, lensReads } from '../lens/lensReads';
import { resolvePolicy } from '../lens/policy';
import { readPaths } from '../lens/readPaths';
import type { Lens, LensNarrowing } from '../lens/types';
import { validateRuleInLens } from '../lens/validateRuleInLens';
import type { ClockUnit } from '../operatorCatalog';
import { valueReads } from '../traverse';
import type { ValueExpression, ValueType } from '../types';
import type { ValidationIssue } from '../validate';
import { inferValueType } from './inferValueType';
import { validateValue } from './validateValue';
import { ValueTypeIssue } from './valueTypeIssue';

/** A value expression under a lens: its type, the dotted paths it reads from the row (a relation's
 *  rows under the relation: `fanMissions.status`), its clock unit, and every problem the
 *  validator, the lens gate and type inference find. Never throws on a bad expression. */
export type ValueDescription = {
  type: ValueType | null;
  paths: string[];
  /** The models it reads, as `describeRule` gives them. */
  reads: LensRead[];
  clockUnit: ClockUnit | null;
  errors: ValidationIssue[];
};

export const describeValue = (
  expression: ValueExpression,
  lensOrNarrowing: Lens | LensNarrowing,
): ValueDescription => {
  const shapeErrors = validateValue(expression).errors;
  if (shapeErrors.length > 0)
    return { type: null, paths: [], reads: [], clockUnit: null, errors: shapeErrors };
  const reads = valueReads(expression);
  const errors = [...validateRuleInLens(reads, lensOrNarrowing).errors];
  let type: ValueType | null = null;
  try {
    type = inferValueType(expression, lensOrNarrowing);
  } catch (error) {
    if (!(error instanceof ValueTypeIssue)) throw error;
    errors.push(error.issue);
  }
  let unit: ClockUnit | null = null;
  try {
    unit = clockUnit(reads);
  } catch (error) {
    errors.push({ path: '$', code: 'clock_unit_below_floor', message: (error as Error).message });
  }
  return {
    type,
    paths: readPaths(reads).sort(),
    reads: lensReads(resolvePolicy(lensOrNarrowing), reads),
    clockUnit: unit,
    errors,
  };
};
