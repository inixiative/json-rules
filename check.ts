import { get } from 'lodash';
import type {ArrayRule, Condition, Rule} from "./types.ts";
import {Operator} from "./operator.ts";

export const check = (conditions: Condition, data: any): boolean | string => {
  if (typeof conditions === 'boolean') return conditions;
  if ('all' in conditions) return all(conditions.all, data, conditions.error);
  if ('any' in conditions) return any(conditions.any, data, conditions.error);
  if ('arrayOperator' in conditions) return checkArray(conditions, data);
  if ('field' in conditions) return checkField(conditions, data);

  return false;
}

const all = (conditions: Condition[], data: any, error?: string): boolean | string => {
  const errors: string[] = [];
  
  for (const condition of conditions) {
    const result = check(condition, data);
    if (typeof result === 'string') errors.push(result);
  }

  if (!errors.length) return true;
  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `All conditions must pass: ${errors.join(' AND ')}`;
}

const any = (conditions: Condition[], data: any, error?: string): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = check(condition, data);
    if (typeof result !== 'string') return true;
    errors.push(result);
  }

  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `At least one condition must pass: ${errors.join(' OR ')}`;
}

const checkArray = (condition: ArrayRule, data: any): boolean | string => {
  // TBD
  return true;
}

const checkField = (condition: Rule, data: any): boolean | string => {
  const fieldValue = get(data, condition.field);
  const value = getValue(condition, data);
  
  const getError = (op: string) => condition.error || `${condition.field} ${op} ${JSON.stringify(value, null, 2)}`;

  switch (condition.operator) {
    case Operator.equal:
      return fieldValue === value || getError(`must equal`);
    case Operator.notEqual:
      return fieldValue !== value || getError(`must not equal`);
    case Operator.lessThan:
      return fieldValue < value || getError(`must be less than`);
    case Operator.lessThanEqual:
      return fieldValue <= value || getError(`must be less than or equal to`);
    case Operator.greaterThan:
      return fieldValue > value || getError(`must be greater than`);
    case Operator.greaterThanEqual:
      return fieldValue >= value || getError(`must be greater than or equal to`);
    case Operator.in:
      return value?.includes(fieldValue) || getError(`must be one of`);
    case Operator.notIn:
      return !value?.includes(fieldValue) || getError(`must not be one of`);
    case Operator.contains:
      return fieldValue?.includes(value) || getError(`must contain`);
    case Operator.notContains:
      return !fieldValue?.includes(value) || getError(`must not contain`);
    case Operator.match:
      return !!fieldValue?.match(value) || getError(`must match pattern`);
    case Operator.notMatch:
      return !fieldValue?.match(value) || getError(`must not match pattern`);
    default:
      throw new Error( 'Unknown operator');
  }
};

const getValue = (condition: Rule, data: any): any => {
  if (condition.value !== undefined) return condition.value;
  if (condition.path) return get(data, condition.path);
  throw new Error('No value or path specified');
};
