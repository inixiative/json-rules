import { get, isObject, some } from 'lodash-es';
import { checkDate } from './date';
import { checkField } from './field';
import { ArrayOperator, Operator } from './operator';
import type { AggregateRule, ArrayRule, Condition, DateConfig } from './types';
import { applyWindow } from './window';

type Row = Record<string, unknown>;
type CheckData = Row | unknown[];

export type CheckOptions = {
  context?: CheckData;
} & DateConfig;

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
  if (typeof conditions === 'boolean') return conditions;

  const opts: CheckOptions = { ...options, context: options?.context ?? data };

  if ('all' in conditions) return all(conditions.all, data, opts, conditions.error);
  if ('any' in conditions) return any(conditions.any, data, opts, conditions.error);
  if ('arrayOperator' in conditions) return checkArray(conditions, data, opts);
  if ('dateOperator' in conditions)
    return checkDate(conditions, data as Row, opts.context as Row, opts);
  if ('aggregate' in conditions) return checkAggregate(conditions as AggregateRule, data, opts);
  if ('field' in conditions) return checkField(conditions, data as Row, opts.context as Row);
  if ('if' in conditions) return checkIfThenElse(conditions, data, opts);

  return false;
};

const all = <TData extends CheckData>(
  conditions: Condition[],
  data: TData,
  opts: CheckOptions,
  error?: string,
): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = check(condition, data, opts);
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
  opts: CheckOptions,
  error?: string,
): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = check(condition, data, opts);
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
  opts: CheckOptions,
): boolean | string => {
  const ifResult = check(condition.if, data, opts);
  if (ifResult === true) return check(condition.then, data, opts);
  // `false` is a legal else value (deny branch); use !== undefined so it's
  // evaluated rather than skipped by truthiness.
  return condition.else !== undefined ? check(condition.else, data, opts) : true;
};

const checkAggregate = <TData extends CheckData>(
  condition: AggregateRule,
  data: TData,
  opts: CheckOptions,
): boolean | string => {
  const rawArray = get(data, condition.field);
  if (!Array.isArray(rawArray)) throw new Error(`${condition.field} must be an array`);
  const arrayValue = applyWindow(rawArray, condition);

  const { mode, field: itemField } = condition.aggregate;
  if (mode !== 'sum' && mode !== 'avg') {
    return condition.error || `${condition.field} aggregate.mode must be 'sum' or 'avg'`;
  }

  const nestedCondition = condition.condition;
  const filtered = nestedCondition
    ? arrayValue.filter((item) => check(nestedCondition, item as Row, opts) === true)
    : arrayValue;

  const numbers: number[] = filtered.map((item, index) => {
    const raw = itemField ? get(item as Row, itemField) : item;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      const loc = `${condition.field}[${index}]${itemField ? `.${itemField}` : ''}`;
      throw new Error(`${loc} must be a finite number`);
    }
    return raw;
  });

  const sum = numbers.reduce((s, n) => s + n, 0);
  const result = mode === 'sum' ? sum : numbers.length === 0 ? 0 : sum / numbers.length;

  const context = opts.context as TData;
  let rhs: unknown;
  if (condition.value !== undefined) {
    rhs = condition.value;
  } else if (condition.path) {
    rhs = condition.path.startsWith('$.')
      ? get(data, condition.path.substring(2))
      : get(context, condition.path);
  } else {
    throw new Error('Aggregate rule requires value or path');
  }

  const getError = (msg: string) =>
    condition.error || `${condition.field} ${mode} ${msg} ${JSON.stringify(rhs)}`;

  switch (condition.operator) {
    case Operator.equals:
      return result === rhs || getError('must equal');
    case Operator.notEquals:
      return result !== rhs || getError('must not equal');
    case Operator.lessThan:
      return (typeof rhs === 'number' && result < rhs) || getError('must be less than');
    case Operator.lessThanEquals:
      return (
        (typeof rhs === 'number' && result <= rhs) || getError('must be less than or equal to')
      );
    case Operator.greaterThan:
      return (typeof rhs === 'number' && result > rhs) || getError('must be greater than');
    case Operator.greaterThanEquals:
      return (
        (typeof rhs === 'number' && result >= rhs) || getError('must be greater than or equal to')
      );
    case Operator.between: {
      if (!Array.isArray(rhs) || rhs.length !== 2)
        throw new Error('between requires a two-element array');
      const [a, b] = rhs as number[];
      const [min, max] = a <= b ? [a, b] : [b, a];
      return (result >= min && result <= max) || getError('must be between');
    }
    case Operator.notBetween: {
      if (!Array.isArray(rhs) || rhs.length !== 2)
        throw new Error('notBetween requires a two-element array');
      const [a, b] = rhs as number[];
      const [min, max] = a <= b ? [a, b] : [b, a];
      return result < min || result > max || getError('must not be between');
    }
    default:
      throw new Error(`Operator '${condition.operator}' is not supported for aggregate rules`);
  }
};

const checkArray = <TData extends CheckData>(
  condition: ArrayRule,
  data: TData,
  opts: CheckOptions,
): boolean | string => {
  const rawArray = condition.field ? get(data, condition.field) : data;

  if (!Array.isArray(rawArray)) throw new Error(`${condition.field || '(root)'} must be an array`);
  const arrayValue = applyWindow(rawArray, condition);

  const getError = (defaultMsg: string) => condition.error || `${condition.field} ${defaultMsg}`;

  const requiresCondition: ArrayOperator[] = [
    ArrayOperator.all,
    ArrayOperator.any,
    ArrayOperator.none,
    ArrayOperator.atLeast,
    ArrayOperator.atMost,
    ArrayOperator.exactly,
  ];

  const requiresCount: ArrayOperator[] = [
    ArrayOperator.atLeast,
    ArrayOperator.atMost,
    ArrayOperator.exactly,
  ];

  const itemCondition = condition.condition;
  if (requiresCondition.includes(condition.arrayOperator) && !itemCondition)
    throw new Error(
      `${condition.arrayOperator} requires a condition to check against array elements`,
    );

  const count = condition.count;
  if (requiresCount.includes(condition.arrayOperator) && count === undefined)
    throw new Error(`${condition.arrayOperator} requires a count`);

  let matches = 0;
  let failures = 0;

  if (requiresCondition.includes(condition.arrayOperator)) {
    if (!itemCondition) {
      throw new Error(
        `${condition.arrayOperator} requires a condition to check against array elements`,
      );
    }

    if (arrayValue.length > 0 && !some(arrayValue, isObject))
      return getError(
        `contains only primitive values; use 'in' or 'contains' instead of array operators on primitive arrays`,
      );

    const results = arrayValue.map((item) => check(itemCondition, item as Row, opts));
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
      if (count === undefined) throw new Error(`${condition.arrayOperator} requires a count`);
      return (
        matches >= count || getError(`at least ${count} elements must match (${matches} matched)`)
      );

    case ArrayOperator.atMost:
      if (count === undefined) throw new Error(`${condition.arrayOperator} requires a count`);
      return (
        matches <= count || getError(`at most ${count} elements must match (${matches} matched)`)
      );

    case ArrayOperator.exactly:
      if (count === undefined) throw new Error(`${condition.arrayOperator} requires a count`);
      return (
        matches === count || getError(`exactly ${count} elements must match (${matches} matched)`)
      );

    default:
      throw new Error(`Unknown array operator: ${(condition as ArrayRule).arrayOperator}`);
  }
};
