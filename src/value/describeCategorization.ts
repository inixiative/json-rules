import { clockUnit } from '../clock';
import { lensReads } from '../lens/lensReads';
import { resolvePolicy } from '../lens/policy';
import { readPaths } from '../lens/readPaths';
import type { Lens, LensNarrowing } from '../lens/types';
import { validateRuleInLens } from '../lens/validateRuleInLens';
import type { ClockUnit } from '../operatorCatalog';
import { allOf, valueReads } from '../traverse';
import type { Categorization, ValueExpression, ValueType } from '../types';
import type { ValidationIssue } from '../validate';
import { describeValue, type ValueDescription } from './describeValue';
import { listType, NULL_TYPE, unify } from './unifyValueTypes';
import { validateCategorization } from './validateCategorization';
import { prefixed } from './validateValue';
import { ValueTypeIssue } from './valueTypeIssue';

/** What `describeCategorization` reports: as `describeValue` does, for the value `categorize` gives. */
export type CategorizationDescription = ValueDescription;

type TypedValue = { type: ValueType; path: string };

const typeOfResult = (
  categorization: Categorization,
  values: TypedValue[],
  hasDefault: boolean,
): ValueType => {
  if (categorization.match === 'all') {
    for (const { type, path } of values)
      if (type.isList)
        throw new ValueTypeIssue({
          path,
          code: 'nested_list',
          message: 'under match: all each value is one item of the list categorize returns',
        });
    return listType(
      values.map(({ type }) => type),
      '$',
    );
  }
  const unified = values.reduce<ValueType | null>(
    (acc, { type, path }) => (acc === null ? type : unify(acc, type, path)),
    null,
  );
  if (unified === null) return NULL_TYPE;
  return hasDefault ? unified : unify(unified, NULL_TYPE, '$');
};

/** A categorization under a lens: the type `categorize` returns (every case's value and the
 *  default unified; a list of them under `match: 'all'`; nullable when nothing may hold and there
 *  is no default), the dotted paths its conditions and values read, its clock unit, and every
 *  problem the validator, the lens gate and type inference find, at the case it was found in.
 *  Never throws on a bad categorization. */
export const describeCategorization = (
  categorization: Categorization,
  lensOrNarrowing: Lens | LensNarrowing,
): CategorizationDescription => {
  const shapeErrors = validateCategorization(categorization).errors;
  if (shapeErrors.length > 0)
    return { type: null, paths: [], reads: [], clockUnit: null, errors: shapeErrors };

  const errors: ValidationIssue[] = [];
  const values: TypedValue[] = [];
  const describeAt = (expression: ValueExpression, path: string) => {
    const described = describeValue(expression, lensOrNarrowing);
    errors.push(...prefixed(described.errors, path));
    if (described.type) values.push({ type: described.type, path });
    return described.errors.length === 0;
  };

  let typable = true;
  categorization.cases.forEach((category, index) => {
    const at = `$.cases[${index}]`;
    errors.push(...prefixed(validateRuleInLens(category.if, lensOrNarrowing).errors, `${at}.if`));
    if (!describeAt(category.then, `${at}.then`)) typable = false;
  });
  const hasDefault = categorization.default !== undefined;
  if (hasDefault && !describeAt(categorization.default as ValueExpression, '$.default'))
    typable = false;

  let type: ValueType | null = null;
  if (typable)
    try {
      type = typeOfResult(categorization, values, hasDefault);
    } catch (error) {
      if (!(error instanceof ValueTypeIssue)) throw error;
      errors.push(error.issue);
    }

  const reads = allOf([
    ...categorization.cases.flatMap((category) => [category.if, valueReads(category.then)]),
    ...(hasDefault ? [valueReads(categorization.default)] : []),
  ]);
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
