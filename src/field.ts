import { get, isEmpty } from 'lodash';
import type { Rule } from './types';
import { Operator } from './operator';

export const checkField = (condition: Rule, data: any, context: any): boolean | string => {
  // Use data for field access (current element) but context remains available for path references
  const fieldValue = get(data, condition.field);
  
  // Operators that don't need a value
  const noValueOps = [Operator.isEmpty, Operator.notEmpty, Operator.exists, Operator.notExists];
  const needsValue = !noValueOps.includes(condition.operator);
  const value = needsValue ? getValue(condition, data, context) : undefined;
  
  const getError = (op: string) => condition.error || `${condition.field} ${op}${needsValue ? ' ' + JSON.stringify(value) : ''}`;

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
    case Operator.between:
      if (!Array.isArray(value) || value.length !== 2) 
        throw new Error('between operator requires an array of two values');
      return (fieldValue >= value[0] && fieldValue <= value[1]) || getError(`must be between`);
    case Operator.notBetween:
      if (!Array.isArray(value) || value.length !== 2) 
        throw new Error('notBetween operator requires an array of two values');
      return (fieldValue < value[0] || fieldValue > value[1]) || getError(`must not be between`);
    case Operator.isEmpty:
      return isEmpty(fieldValue) || getError(`must be empty`);
    case Operator.notEmpty:
      return !isEmpty(fieldValue) || getError(`must not be empty`);
    case Operator.exists:
      return fieldValue !== undefined || getError(`must exist`);
    case Operator.notExists:
      return fieldValue === undefined || getError(`must not exist`);
    case Operator.startsWith:
      return fieldValue?.startsWith?.(value) || getError(`must start with`);
    case Operator.endsWith:
      return fieldValue?.endsWith?.(value) || getError(`must end with`);
    default:
      throw new Error('Unknown operator');
  }
};

const getValue = (condition: Rule, data: any, context: any): any => {
  if (condition.value !== undefined) return condition.value;
  if (condition.path) {
    // Special case: if path starts with "$." use data (current element)
    if (condition.path.startsWith('$.')) {
      return get(data, condition.path.substring(2));
    }
    // Otherwise use context (root data)
    return get(context, condition.path);
  }
  throw new Error('No value or path specified');
};