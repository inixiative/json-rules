import { get } from 'lodash';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import type { DateRule } from './types';
import { DateOperator } from './operator';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export const checkDate = (condition: DateRule, data: any, context: any): boolean | string => {
  const fieldValue = get(data, condition.field);
  
  if (!fieldValue) throw new Error(`${condition.field} is null or undefined`);
  
  const fieldDate = dayjs(fieldValue);
  
  if (!fieldDate.isValid()) throw new Error(`${condition.field} is not a valid date: ${fieldValue}`);
  
  const getError = (op: string) => condition.error || `${condition.field} ${op}`;
  
  // Parse comparison dates
  const dates = parseCompareDates(condition, data, context);
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

const parseCompareDates = (condition: DateRule, data: any, context: any): [dayjs.Dayjs, dayjs.Dayjs | undefined] => {
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
    let value;
    if (condition.value !== undefined) {
      value = condition.value;
    } else if (condition.path) {
      // Support $.path for current element
      if (condition.path.startsWith('$.')) {
        value = get(data, condition.path.substring(2));
      } else {
        value = get(context, condition.path);
      }
    } else {
      throw new Error('No value or path specified for date comparison');
    }
    const date = dayjs(value);
    if (!date.isValid()) throw new Error(`Invalid comparison date: ${value}`);
    return [date, undefined];
  }
  
  return [dayjs(), undefined]; // Won't be used for dayIn/dayNotIn
}