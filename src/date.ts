import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { get } from 'lodash';
import { DateOperator } from './operator';
import type { DateInputValue, DateRule } from './types';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export const checkDate = <TData extends Record<string, unknown>>(
  condition: DateRule,
  data: TData,
  context: TData,
): boolean | string => {
  const fieldValue = get(data, condition.field) as unknown;

  if (!fieldValue) throw new Error(`${condition.field} is null or undefined`);
  if (!isDateInputValue(fieldValue))
    throw new Error(`${condition.field} is not a valid date: ${String(fieldValue)}`);

  const fieldDate = dayjs(fieldValue);

  if (!fieldDate.isValid())
    throw new Error(`${condition.field} is not a valid date: ${fieldValue}`);

  const getError = (op: string) => condition.error || `${condition.field} ${op}`;

  // Parse comparison dates with timezone context - pass the original string to preserve offset info
  const dates = parseCompareDates(condition, data, context, fieldDate, fieldValue);
  const compareDate = dates[0];
  const endDate = dates[1];

  switch (condition.dateOperator) {
    case DateOperator.before:
      return fieldDate.isBefore(compareDate) || getError(`must be before ${compareDate.format()}`);

    case DateOperator.after:
      return fieldDate.isAfter(compareDate) || getError(`must be after ${compareDate.format()}`);

    case DateOperator.onOrBefore:
      return (
        fieldDate.isSameOrBefore(compareDate) ||
        getError(`must be on or before ${compareDate.format()}`)
      );

    case DateOperator.onOrAfter:
      return (
        fieldDate.isSameOrAfter(compareDate) ||
        getError(`must be on or after ${compareDate.format()}`)
      );

    case DateOperator.between: {
      if (!endDate) throw new Error('between operator requires an end date');
      return (
        (fieldDate.isSameOrAfter(compareDate) && fieldDate.isSameOrBefore(endDate)) ||
        getError(`must be between ${compareDate.format()} and ${endDate?.format()}`)
      );
    }

    case DateOperator.notBetween: {
      if (!endDate) throw new Error('notBetween operator requires an end date');
      return (
        fieldDate.isBefore(compareDate) ||
        fieldDate.isAfter(endDate) ||
        getError(`must not be between ${compareDate.format()} and ${endDate?.format()}`)
      );
    }

    case DateOperator.dayIn: {
      if (!Array.isArray(condition.value))
        throw new Error('dayIn operator requires an array of day names');
      const dayName = fieldDate.format('dddd').toLowerCase();
      const allowedDays = condition.value.map((day) => String(day).toLowerCase());
      return allowedDays.includes(dayName) || getError(`must be on ${allowedDays.join(' or ')}`);
    }

    case DateOperator.dayNotIn: {
      if (!Array.isArray(condition.value))
        throw new Error('dayNotIn operator requires an array of day names');
      const day = fieldDate.format('dddd').toLowerCase();
      const excludedDays = condition.value.map((excludedDay) => String(excludedDay).toLowerCase());
      return !excludedDays.includes(day) || getError(`must not be on ${excludedDays.join(' or ')}`);
    }

    default:
      throw new Error('Unknown date operator');
  }
};

const parseCompareDates = <TData extends Record<string, unknown>>(
  condition: DateRule,
  data: TData,
  context: TData,
  _fieldDate: dayjs.Dayjs,
  fieldValue: DateInputValue,
): [dayjs.Dayjs, dayjs.Dayjs | undefined] => {
  const requiresTwoDates: DateOperator[] = [DateOperator.between, DateOperator.notBetween];

  if (requiresTwoDates.includes(condition.dateOperator)) {
    if (!Array.isArray(condition.value) || condition.value.length !== 2)
      throw new Error(`${condition.dateOperator} operator requires an array of two dates`);
    const [rawDate1, rawDate2] = condition.value as [DateInputValue, DateInputValue];
    const date1 = parseDateWithTimezone(rawDate1, fieldValue);
    const date2 = parseDateWithTimezone(rawDate2, fieldValue);
    if (!date1.isValid()) throw new Error(`Invalid start date: ${condition.value[0]}`);
    if (!date2.isValid()) throw new Error(`Invalid end date: ${condition.value[1]}`);
    // Auto-sort: ensure startDate <= endDate
    const [startDate, endDate] =
      date1.isBefore(date2) || date1.isSame(date2) ? [date1, date2] : [date2, date1];
    return [startDate, endDate];
  }

  const requiresOneDate: DateOperator[] = [
    DateOperator.before,
    DateOperator.after,
    DateOperator.onOrBefore,
    DateOperator.onOrAfter,
  ];

  if (requiresOneDate.includes(condition.dateOperator)) {
    let value: DateInputValue | undefined;
    if (condition.value !== undefined) {
      if (Array.isArray(condition.value)) {
        throw new Error(`${condition.dateOperator} operator requires a single date value`);
      }
      value = condition.value as DateInputValue;
    } else if (condition.path) {
      // Support $.path for current element
      if (condition.path.startsWith('$.')) {
        const pathValue = get(data, condition.path.substring(2)) as unknown;
        value = isDateInputValue(pathValue) ? pathValue : undefined;
      } else {
        const pathValue = get(context, condition.path) as unknown;
        value = isDateInputValue(pathValue) ? pathValue : undefined;
      }
    } else {
      throw new Error('No value or path specified for date comparison');
    }
    const date = parseDateWithTimezone(value, fieldValue);
    if (!date.isValid()) throw new Error(`Invalid comparison date: ${value}`);
    return [date, undefined];
  }

  return [dayjs(), undefined]; // Won't be used for dayIn/dayNotIn
};

const parseDateWithTimezone = (
  value: DateInputValue | undefined,
  fieldValue: DateInputValue,
): dayjs.Dayjs => {
  const valueStr = String(value);

  // Check if value has explicit timezone information
  const hasTimezone =
    valueStr.includes('Z') ||
    (valueStr.includes('T') && (valueStr.includes('+') || valueStr.match(/T.*-\d{2}:/)));

  if (hasTimezone) return dayjs(value);

  // No timezone info in value - interpret in field's timezone
  // Extract offset from field value
  const fieldStr = String(fieldValue);
  let offset = 0;

  if (fieldStr.includes('+') || (fieldStr.includes('T') && fieldStr.match(/T.*-\d{2}:/))) {
    // Field has explicit offset like +11:00 or -08:00
    const match = fieldStr.match(/([+-])(\d{2}):(\d{2})/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      offset = sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    }
  } else if (!fieldStr.includes('Z')) {
    // Field has no timezone, assume local time (offset 0)
    offset = 0;
  }
  // If field has Z, it's UTC (offset 0)

  // Create a date representing the same local time as the field's timezone
  if (valueStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    // For date-only, we want midnight in the field's timezone
    const localMidnight = dayjs(`${value}T00:00:00`);
    return localMidnight.subtract(offset, 'minute');
  }

  // For datetime without timezone, interpret as local time in field's timezone
  const localTime = dayjs(value);
  return localTime.subtract(offset, 'minute');
};

const isDateInputValue = (value: unknown): value is DateInputValue =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;
