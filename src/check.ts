import { isObject, some } from 'lodash-es';
import { checkDate } from './date';
import { conditionRequired } from './errors';
import { checkField } from './field';
import { ArrayOperator } from './operator';
import { ARRAY_CONDITION_OPERATORS, ARRAY_COUNT_OPERATORS } from './operatorCatalog';
import { readField, readOwnPath, type Scopes } from './scope';
import type {
  AggregateRule,
  ArrayRule,
  CheckData,
  Condition,
  DateConfig,
  Row,
  Rule,
  RuleValue,
} from './types';
import { applyWindow } from './window';

export type CheckOptions = {
  context?: CheckData;
  bindings?: Record<string, RuleValue>;
} & DateConfig;

type EvalOptions = CheckOptions & { context: CheckData; scopes: Scopes };

const validateRootArrayShape = (rule: Condition): void => {
  if (typeof rule === 'boolean') return;
  if ('all' in rule) {
    for (const c of rule.all) validateRootArrayShape(c);
    return;
  }
  if ('any' in rule) {
    for (const c of rule.any) validateRootArrayShape(c);
    return;
  }
  if ('arrayOperator' in rule && !('field' in rule)) return;
  throw new Error(
    'check: when data is an array, every leaf must be a fieldless arrayOperator (composable with all/any)',
  );
};

export const check = <TData extends CheckData>(
  conditions: Condition,
  data: TData,
  options?: CheckOptions,
): boolean | string => {
  if (Array.isArray(data)) validateRootArrayShape(conditions);
  return evaluate(conditions, data, {
    ...options,
    context: options?.context ?? data,
    scopes: [data],
  });
};

const evaluate = <TData extends CheckData>(
  conditions: Condition,
  data: TData,
  opts: EvalOptions,
): boolean | string => {
  if (typeof conditions === 'boolean') return conditions;

  if ('all' in conditions) return all(conditions.all, data, opts, conditions.error);
  if ('any' in conditions) return any(conditions.any, data, opts, conditions.error);
  if ('arrayOperator' in conditions) return checkArray(conditions, opts);
  if ('dateOperator' in conditions)
    return checkDate(conditions, opts.scopes, opts.context as Row, opts, opts.bindings);
  if ('aggregate' in conditions) return checkAggregate(conditions as AggregateRule, opts);
  if ('field' in conditions)
    return checkField(conditions, opts.scopes, opts.context as Row, opts.bindings, opts);
  if ('if' in conditions) return checkIfThenElse(conditions, data, opts);

  return false;
};

const enter = (opts: EvalOptions, item: unknown): EvalOptions => ({
  ...opts,
  scopes: [...opts.scopes, item],
});

const all = <TData extends CheckData>(
  conditions: Condition[],
  data: TData,
  opts: EvalOptions,
  error?: string,
): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = evaluate(condition, data, opts);
    if (result !== true) {
      if (typeof result === 'string') {
        errors.push(result);
      } else {
        errors.push('false');
      }
    }
  }

  if (!errors.length) return true;
  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `All conditions must pass: ${errors.join(' AND ')}`;
};

const any = <TData extends CheckData>(
  conditions: Condition[],
  data: TData,
  opts: EvalOptions,
  error?: string,
): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = evaluate(condition, data, opts);
    if (result === true) return true;
    if (typeof result === 'string') errors.push(result);
  }

  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `At least one condition must pass: ${errors.join(' OR ')}`;
};

const checkIfThenElse = <TData extends CheckData>(
  condition: { if: Condition; then: Condition; else?: Condition },
  data: TData,
  opts: EvalOptions,
): boolean | string => {
  const ifResult = evaluate(condition.if, data, opts);
  if (ifResult === true) return evaluate(condition.then, data, opts);
  // `false` is a legal else value (deny branch); use !== undefined so it's
  // evaluated rather than skipped by truthiness.
  return condition.else !== undefined ? evaluate(condition.else, data, opts) : true;
};

/** The array a rule reads; an absent or NULL one is empty, as on the compiled rails. */
const readArray = (value: unknown, field: string): unknown[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
};

const checkAggregate = (condition: AggregateRule, opts: EvalOptions): boolean | string => {
  const rawArray = readArray(readField(condition.field, opts.scopes), condition.field);
  const windowFilter = condition.filter;
  const arrayValue = applyWindow(
    rawArray,
    condition,
    windowFilter
      ? (item) => evaluate(windowFilter, item as Row, enter(opts, item)) === true
      : undefined,
  );

  const { mode, field: itemField } = condition.aggregate;
  if (mode !== 'sum' && mode !== 'avg') {
    return condition.error || `${condition.field} aggregate.mode must be 'sum' or 'avg'`;
  }

  const nestedCondition = condition.condition;
  const filtered = nestedCondition
    ? arrayValue.filter(
        (item) => evaluate(nestedCondition, item as Row, enter(opts, item)) === true,
      )
    : arrayValue;

  // NULL items are skipped, as SQL's SUM and AVG skip them.
  const numbers: number[] = filtered.flatMap((item, index) => {
    const raw = itemField ? readOwnPath(item, itemField) : item;
    if (raw === null || raw === undefined) return [];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      const loc = `${condition.field}[${index}]${itemField ? `.${itemField}` : ''}`;
      throw new Error(`${loc} must be a finite number`);
    }
    return [raw];
  });

  // An aggregate compares like a field whose value it computes; the sum and the average of
  // nothing are 0 (the compilers coalesce to match).
  const sum = numbers.reduce((total, n) => total + n, 0);
  const result = mode === 'sum' || numbers.length === 0 ? sum : sum / numbers.length;
  const labelled = { ...condition, field: `${condition.field} ${mode}` } as unknown as Rule;
  return checkField(labelled, opts.scopes, opts.context, opts.bindings, opts, { value: result });
};

const checkArray = (condition: ArrayRule, opts: EvalOptions): boolean | string => {
  const rawArray = readArray(
    condition.field ? readField(condition.field, opts.scopes) : opts.scopes[opts.scopes.length - 1],
    condition.field || '(root)',
  );
  const windowFilter = condition.filter;
  const arrayValue = applyWindow(
    rawArray,
    condition,
    windowFilter
      ? (item) => evaluate(windowFilter, item as Row, enter(opts, item)) === true
      : undefined,
  );

  const getError = (defaultMsg: string) => condition.error || `${condition.field} ${defaultMsg}`;

  const itemCondition = condition.condition;
  const elementwise = ARRAY_CONDITION_OPERATORS.includes(condition.arrayOperator);
  if (elementwise && itemCondition === undefined) throw conditionRequired(condition.arrayOperator);

  const count = condition.count ?? 0;
  if (ARRAY_COUNT_OPERATORS.includes(condition.arrayOperator) && condition.count === undefined)
    throw new Error(`${condition.arrayOperator} requires a count`);

  let matches = 0;
  let failures = 0;

  if (elementwise && itemCondition !== undefined) {
    if (arrayValue.length > 0 && !some(arrayValue, isObject))
      return getError(
        `contains only primitive values; use 'in' or 'contains' instead of array operators on primitive arrays`,
      );

    const results = arrayValue.map((item) =>
      evaluate(itemCondition, item as Row, enter(opts, item)),
    );
    matches = results.filter((r) => r === true).length;
    failures = results.filter((r) => typeof r === 'string').length;
  }

  switch (condition.arrayOperator) {
    case ArrayOperator.empty:
      return !arrayValue.length || getError('must be empty');

    case ArrayOperator.notEmpty:
      return !!arrayValue.length || getError('must not be empty');

    case ArrayOperator.all:
      return (
        matches === arrayValue.length || getError(`all elements must match (${failures} failed)`)
      );

    case ArrayOperator.any:
      return !!matches || getError('at least one element must match');

    case ArrayOperator.none:
      return !matches || getError(`no elements should match (${matches} matched)`);

    case ArrayOperator.atLeast:
      return (
        matches >= count || getError(`at least ${count} elements must match (${matches} matched)`)
      );

    case ArrayOperator.atMost:
      return (
        matches <= count || getError(`at most ${count} elements must match (${matches} matched)`)
      );

    case ArrayOperator.exactly:
      return (
        matches === count || getError(`exactly ${count} elements must match (${matches} matched)`)
      );

    default:
      throw new Error(`Unknown array operator: ${(condition as ArrayRule).arrayOperator}`);
  }
};
