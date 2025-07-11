import { get, some, isObject } from 'lodash';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type {ArrayRule, Condition, Rule, IfThenElse, DateRule} from "./types.ts";
import {Operator, ArrayOperator, DateOperator} from "./operator.ts";

dayjs.extend(utc);
dayjs.extend(timezone);

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
    if (typeof result === 'string') errors.push(result);
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

const checkIfThenElse = (condition: IfThenElse, data: any, context: any): boolean | string => {
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

const isEmpty = (value: any): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

const checkDate = (condition: DateRule, data: any, context: any): boolean | string => {
  const fieldValue = get(context, condition.field);
  
  if (!fieldValue) throw new Error(`${condition.field} is null or undefined`);
  
  const fieldDate = dayjs(fieldValue);
  
  if (!fieldDate.isValid()) throw new Error(`${condition.field} is not a valid date: ${fieldValue}`);
  
  const getError = (op: string) => condition.error || `${condition.field} ${op}`;
  
  // Parse comparison dates
  const dates = parseCompareDates(condition, context);
  const compareDate = dates[0];
  const endDate = dates[1];
  
  switch (condition.dateOperator) {
    case DateOperator.before:
      return fieldDate.isBefore(compareDate) || getError(`must be before ${compareDate.format()}`);
      
    case DateOperator.after:
      return fieldDate.isAfter(compareDate) || getError(`must be after ${compareDate.format()}`);
      
    case DateOperator.onOrBefore:
      return fieldDate.isSameOrBefore(compareDate) || getError(`must be on or before ${compareDate.format()}`);
      
    case DateOperator.onOrAfter:
      return fieldDate.isSameOrAfter(compareDate) || getError(`must be on or after ${compareDate.format()}`);
      
    case DateOperator.between:
      return (fieldDate.isSameOrAfter(compareDate) && fieldDate.isSameOrBefore(endDate!)) || 
        getError(`must be between ${compareDate.format()} and ${endDate!.format()}`);
      
    case DateOperator.notBetween:
      return (fieldDate.isBefore(compareDate) || fieldDate.isAfter(endDate!)) || 
        getError(`must not be between ${compareDate.format()} and ${endDate!.format()}`);
      
    case DateOperator.dayIn:
      if (!Array.isArray(condition.value)) throw new Error('dayIn operator requires an array of day names');
      const dayName = fieldDate.format('dddd').toLowerCase();
      const allowedDays = condition.value.map(d => d.toLowerCase());
      return allowedDays.includes(dayName) || getError(`must be on ${allowedDays.join(' or ')}`);
      
    case DateOperator.dayNotIn:
      if (!Array.isArray(condition.value)) throw new Error('dayNotIn operator requires an array of day names');
      const day = fieldDate.format('dddd').toLowerCase();
      const excludedDays = condition.value.map(d => d.toLowerCase());
      return !excludedDays.includes(day) || getError(`must not be on ${excludedDays.join(' or ')}`);
      
    default:
      throw new Error('Unknown date operator');
  }
}

const parseCompareDates = (condition: DateRule, context: any): [dayjs.Dayjs, dayjs.Dayjs | undefined] => {
  const requiresTwoDates = [DateOperator.between, DateOperator.notBetween];
  
  if (requiresTwoDates.includes(condition.dateOperator)) {
    if (!Array.isArray(condition.value) || condition.value.length !== 2) 
      throw new Error(`${condition.dateOperator} operator requires an array of two dates`);
    const startDate = dayjs(condition.value[0]);
    const endDate = dayjs(condition.value[1]);
    if (!startDate.isValid()) throw new Error(`Invalid start date: ${condition.value[0]}`);
    if (!endDate.isValid()) throw new Error(`Invalid end date: ${condition.value[1]}`);
    return [startDate, endDate];
  }
  
  const requiresOneDate = [
    DateOperator.before,
    DateOperator.after,
    DateOperator.onOrBefore,
    DateOperator.onOrAfter
  ];
  
  if (requiresOneDate.includes(condition.dateOperator)) {
    const value = condition.path ? get(context, condition.path) : condition.value;
    if (!value) throw new Error('No value or path specified for date comparison');
    const date = dayjs(value);
    if (!date.isValid()) throw new Error(`Invalid comparison date: ${value}`);
    return [date, undefined];
  }
  
  return [dayjs(), undefined]; // Won't be used for dayIn/dayNotIn
}

const checkField = (condition: Rule, data: any, context: any): boolean | string => {
  const fieldValue = get(context, condition.field);
  
  // Operators that don't need a value
  const noValueOps = [Operator.isEmpty, Operator.notEmpty, Operator.exists, Operator.notExists];
  const needsValue = !noValueOps.includes(condition.operator);
  const value = needsValue ? getValue(condition, context) : undefined;
  
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
      if (!Array.isArray(value) || value.length !== 2) {
        throw new Error('between operator requires an array of two values');
      }
      return (fieldValue >= value[0] && fieldValue <= value[1]) || getError(`must be between`);
    case Operator.notBetween:
      if (!Array.isArray(value) || value.length !== 2) {
        throw new Error('notBetween operator requires an array of two values');
      }
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

const getValue = (condition: Rule, data: any): any => {
  if (condition.value !== undefined) return condition.value;
  if (condition.path) return get(data, condition.path);
  throw new Error('No value or path specified');
};
