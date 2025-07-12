import { get, some, isObject } from 'lodash';
import type { Condition, ArrayRule } from './types';
import { ArrayOperator } from './operator';
import { checkDate } from './date';
import { checkField } from './field';

export const check = (conditions: Condition, data: any, context: any = data): boolean | string => {
  if (typeof conditions === 'boolean') return conditions;
  if ('all' in conditions) return all(conditions.all, data, context, conditions.error);
  if ('any' in conditions) return any(conditions.any, data, context, conditions.error);
  if ('arrayOperator' in conditions) return checkArray(conditions, data, context);
  if ('dateOperator' in conditions) return checkDate(conditions, data, context);
  if ('field' in conditions) return checkField(conditions, data, context);
  if ('if' in conditions) return checkIfThenElse(conditions, data, context);

  return false;
}

const all = (conditions: Condition[], data: any, context: any, error?: string): boolean | string => {
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
}

const any = (conditions: Condition[], data: any, context: any, error?: string): boolean | string => {
  const errors: string[] = [];

  for (const condition of conditions) {
    const result = check(condition, data, context);
    if (typeof result !== 'string') return true;
    errors.push(result);
  }

  if (error) return error;
  if (errors.length === 1) return errors[0];
  return `At least one condition must pass: ${errors.join(' OR ')}`;
}

const checkIfThenElse = (condition: any, data: any, context: any): boolean | string => {
  const ifResult = check(condition.if, data, context);
  
  if (ifResult === true) return check(condition.then, data, context);
  return condition.else ? check(condition.else, data, context) : true;
}

const checkArray = (condition: ArrayRule, data: any, context: any): boolean | string => {
  const arrayValue = get(context, condition.field);
  
  if (!Array.isArray(arrayValue)) throw new Error(`${condition.field} must be an array`);
  
  const getError = (defaultMsg: string) => condition.error || `${condition.field} ${defaultMsg}`;
  
  // Operators that require a condition
  const requiresCondition = [
    ArrayOperator.all, 
    ArrayOperator.any, 
    ArrayOperator.none,
    ArrayOperator.atLeast,
    ArrayOperator.atMost,
    ArrayOperator.exactly
  ];
  
  // Operators that require a count
  const requiresCount = [
    ArrayOperator.atLeast,
    ArrayOperator.atMost,
    ArrayOperator.exactly
  ];
  
  if (requiresCondition.includes(condition.arrayOperator) && !condition.condition) 
    throw new Error(`${condition.arrayOperator} requires a condition to check against array elements`);
  
  if (requiresCount.includes(condition.arrayOperator) && condition.count === undefined) 
    throw new Error(`${condition.arrayOperator} requires a count`);
  
  // For operators that check elements, compute matches
  let matches = 0;
  let failures = 0;
  
  if (requiresCondition.includes(condition.arrayOperator)) {
    // Check if array contains any objects
    if (!some(arrayValue, isObject)) 
      throw new Error(`${condition.field} contains only primitive values. Use 'in' or 'contains' operators instead of array operators for primitive arrays`);
    
    // Pass item as data (for relative field access) but keep original context (for path access)
    const results = arrayValue.map(item => check(condition.condition!, item, context));
    matches = results.filter(r => r === true).length;
    failures = results.filter(r => typeof r === 'string').length;
  }
  
  switch (condition.arrayOperator) {
    case ArrayOperator.empty:
      return !arrayValue.length || getError('must be empty');
      
    case ArrayOperator.notEmpty:
      return !!arrayValue.length || getError('must not be empty');
      
    case ArrayOperator.all:
      return matches === arrayValue.length || getError(`all elements must match (${failures} failed)`);
      
    case ArrayOperator.any:
      return !!matches || getError('at least one element must match');
      
    case ArrayOperator.none:
      return !matches || getError(`no elements should match (${matches} matched)`);
      
    case ArrayOperator.atLeast:
      return matches >= condition.count! || getError(`at least ${condition.count} elements must match (${matches} matched)`);
      
    case ArrayOperator.atMost:
      return matches <= condition.count! || getError(`at most ${condition.count} elements must match (${matches} matched)`);
      
    case ArrayOperator.exactly:
      return matches === condition.count! || getError(`exactly ${condition.count} elements must match (${matches} matched)`);
      
    default:
      throw new Error('Unknown array operator');
  }
}