import { get, isObject, some } from 'lodash-es';
import { checkDate } from './date';
import { checkField } from './field';
import { ArrayOperator, Operator } from './operator';
import { readField, readPath, type Scopes } from './scope';
import type { AggregateRule, ArrayRule, Condition, DateConfig, RuleValue } from './types';
import { applyWindow } from './window';

type Row = Record<string, unknown>;
type CheckData = Row | unknown[];

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
    return checkField(conditions, opts.scopes, opts.context as Row, opts.bindings);
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

const checkAggregate = (condition: AggregateRule, opts: EvalOptions): boolean | string => {
  const rawArray = readField(condition.field, opts.scopes);
  if (!Array.isArray(rawArray)) throw new Error(`${condition.field} must be an array`);
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

  let rhs: unknown;
  if (condition.value !== undefined) {
    rhs = condition.value;
  } else if (condition.path) {
    rhs = readPath(condition.path, opts.scopes, opts.context);
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

const checkArray = (condition: ArrayRule, opts: EvalOptions): boolean | string => {
  const rawArray = condition.field
    ? readField(condition.field, opts.scopes)
    : opts.scopes[opts.scopes.length - 1];

  if (!Array.isArray(rawArray)) throw new Error(`${condition.field || '(root)'} must be an array`);
  const windowFilter = condition.filter;
  const arrayValue = applyWindow(
    rawArray,
    condition,
    windowFilter
      ? (item) => evaluate(windowFilter, item as Row, enter(opts, item)) === true
      : undefined,
  );

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
  if (requiresCondition.includes(condition.arrayOperator) && itemCondition === undefined)
    throw new Error(
      `${condition.arrayOperator} requires a condition to check against array elements`,
    );

  const count = condition.count;
  if (requiresCount.includes(condition.arrayOperator) && count === undefined)
    throw new Error(`${condition.arrayOperator} requires a count`);

  let matches = 0;
  let failures = 0;

  if (requiresCondition.includes(condition.arrayOperator)) {
    if (itemCondition === undefined) {
      throw new Error(
        `${condition.arrayOperator} requires a condition to check against array elements`,
      );
    }

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
