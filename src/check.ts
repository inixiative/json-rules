import { get, isObject, some } from 'lodash';
import { checkDate } from './date';
import { checkField } from './field';
import { ArrayOperator, Operator } from './operator';
import type { AggregateRule, ArrayRule, Condition } from './types';

export const check = <TData extends Record<string, unknown>>(
  conditions: Condition,
  data: TData,
  context: TData = data,
): boolean | string => {
  if (typeof conditions === 'boolean') return conditions;
  if ('all' in conditions) return all(conditions.all, data, context, conditions.error);
  if ('any' in conditions) return any(conditions.any, data, context, conditions.error);
  if ('arrayOperator' in conditions) return checkArray(conditions, data, context);
  if ('dateOperator' in conditions) return checkDate(conditions, data, context);
  if ('aggregate' in conditions) return checkAggregate(conditions as AggregateRule, data, context);
  if ('field' in conditions) return checkField(conditions, data, context);
  if ('if' in conditions) return checkIfThenElse(conditions, data, context);

  return false;
};

const all = <TData extends Record<string, unknown>>(
  conditions: Condition[],
  data: TData,
  context: TData,
  error?: string,
): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = check(condition, data, context);
    if (result !== true) {
      // Handle both string errors and false boolean results
      if (typeof result === 'string') {
        errors.push(result);
      } else {
        // For boolean false, include it in the error message
        errors.push('false');
      }
    }
  }

  if (!errors.length) return true;
  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `All conditions must pass: ${errors.join(' AND ')}`;
};

const any = <TData extends Record<string, unknown>>(
  conditions: Condition[],
  data: TData,
  context: TData,
  error?: string,
): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = check(condition, data, context);
    if (result === true) return true;
    if (typeof result === 'string') errors.push(result);
    // boolean false: record as failure but continue checking other conditions
  }

  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `At least one condition must pass: ${errors.join(' OR ')}`;
};

const checkIfThenElse = <TData extends Record<string, unknown>>(
  condition: { if: Condition; then: Condition; else?: Condition },
  data: TData,
  context: TData,
): boolean | string => {
  const ifResult = check(condition.if, data, context);

  if (ifResult === true) return check(condition.then, data, context);
  return condition.else ? check(condition.else, data, context) : true;
};

const checkAggregate = <TData extends Record<string, unknown>>(
  condition: AggregateRule,
  data: TData,
  context: TData,
): boolean | string => {
  const arrayValue = get(data, condition.field);
  if (!Array.isArray(arrayValue)) throw new Error(`${condition.field} must be an array`);

  // Filter elements by condition before aggregating
  const filtered = condition.condition
    ? arrayValue.filter(
        (item) => check(condition.condition!, item as Record<string, unknown>, context) === true,
      )
    : arrayValue;

  const { mode, field: itemField } = condition.aggregate;

  const numbers: number[] = filtered.map((item, index) => {
    const raw = itemField ? get(item as Record<string, unknown>, itemField) : item;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      const loc = `${condition.field}[${index}]${itemField ? `.${itemField}` : ''}`;
      throw new Error(`${loc} must be a finite number`);
    }
    return raw;
  });

  // sum([]) = 0, avg([]) = null → comparison fails
  let result: number | null;
  if (mode === 'sum') {
    result = numbers.reduce((s, n) => s + n, 0);
  } else {
    result = numbers.length === 0 ? null : numbers.reduce((s, n) => s + n, 0) / numbers.length;
  }

  if (result === null) {
    return condition.error || `${condition.field} ${mode} comparison failed (empty array)`;
  }

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

const checkArray = <TData extends Record<string, unknown>>(
  condition: ArrayRule,
  data: TData,
  context: TData,
): boolean | string => {
  const arrayValue = get(data, condition.field);

  if (!Array.isArray(arrayValue)) throw new Error(`${condition.field} must be an array`);

  const getError = (defaultMsg: string) => condition.error || `${condition.field} ${defaultMsg}`;

  // Operators that require a condition
  const requiresCondition: ArrayOperator[] = [
    ArrayOperator.all,
    ArrayOperator.any,
    ArrayOperator.none,
    ArrayOperator.atLeast,
    ArrayOperator.atMost,
    ArrayOperator.exactly,
  ];

  // Operators that require a count
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

  // For operators that check elements, compute matches
  let matches = 0;
  let failures = 0;

  if (requiresCondition.includes(condition.arrayOperator)) {
    if (!itemCondition) {
      throw new Error(
        `${condition.arrayOperator} requires a condition to check against array elements`,
      );
    }

    // Check if array contains any objects
    if (!some(arrayValue, isObject))
      throw new Error(
        `${condition.field} contains only primitive values. Use 'in' or 'contains' operators instead of array operators for primitive arrays`,
      );

    // Pass item as data (for relative field access) but keep original context (for path access)
    const results = arrayValue.map((item) =>
      check(itemCondition, item as Record<string, unknown>, context),
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
      throw new Error('Unknown array operator');
  }
};
