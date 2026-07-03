import { get } from 'lodash-es';
import { Operator } from './operator';
import type { FieldKind } from './operatorCatalog';
import type { Rule, RuleValue } from './types';

// A value is "empty" iff it is null, undefined, or the empty string — matching the
// SQL backend `(field IS NULL OR field = '')` and Prisma `equals:null | equals:''`.
// (lodash isEmpty would also treat Dates/numbers/populated arrays as empty, which
// diverges from the compilers and breaks soft-delete grants like `deletedAt isEmpty`.)
const isEmptyValue = (value: unknown): boolean =>
  value === null || value === undefined || value === '';

// Mirrors the server-side coerceValueForField contract: null/undefined pass through
// (the is-null sentinel is valid on every field), arrays coerce element-wise, unknown
// kinds pass through, and an uncoercible value returns unchanged so the comparison
// fails with the rule's normal error instead of throwing on one dirty row.
const NUMERIC_COERCE_KINDS: readonly FieldKind[] = ['Int', 'BigInt', 'Float', 'Decimal'];

// A datetime string with a time part but no explicit zone (no trailing Z / ±HH:MM).
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const coerceScalar = (value: unknown, kind: FieldKind): unknown => {
  if (value === null || value === undefined) return value;

  if (NUMERIC_COERCE_KINDS.includes(kind)) {
    if (typeof value !== 'string' || value.trim() === '') return value;
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }

  switch (kind) {
    case 'DateTime': {
      // Everything lands on epoch ms so equals/ordered compare across Date
      // instances, ISO strings (any zone/format), and ms-timestamp strings.
      // A naive (zoneless) datetime string anchors in UTC — deterministic across
      // hosts, matching the date rail's parseDateValue default (Date.parse would
      // anchor it in the host's local zone).
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number') return value;
      if (typeof value !== 'string') return value;
      if (/^-?\d+$/.test(value)) return Number(value);
      const anchored = NAIVE_DATETIME.test(value) ? `${value.replace(' ', 'T')}Z` : value;
      const ms = Date.parse(anchored);
      return Number.isNaN(ms) ? value : ms;
    }
    case 'Boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    case 'String':
      return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
        ? String(value)
        : value;
    default:
      return value;
  }
};

const applyCoercion = (value: unknown, kind: FieldKind | undefined): unknown => {
  if (kind === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => coerceScalar(item, kind));
  return coerceScalar(value, kind);
};

export const checkField = <TData extends Record<string, unknown>>(
  condition: Rule,
  data: TData,
  context: TData,
  bindings?: Record<string, RuleValue>,
): boolean | string => {
  // Use data for field access (current element) but context remains available for path references
  const fieldValue = applyCoercion(get(data, condition.field) as unknown, condition.coerceType);

  // Operators that don't need a value
  const noValueOps: Operator[] = [
    Operator.isEmpty,
    Operator.notEmpty,
    Operator.exists,
    Operator.notExists,
  ];
  const needsValue = !noValueOps.includes(condition.operator);
  const value = needsValue
    ? applyCoercion(getValue(condition, data, context, bindings), condition.coerceType)
    : undefined;

  const getError = (op: string) =>
    condition.error || `${condition.field} ${op}${needsValue ? ` ${JSON.stringify(value)}` : ''}`;

  switch (condition.operator) {
    case Operator.equals:
      return fieldValue === value || getError(`must equal`);
    case Operator.notEquals:
      return fieldValue !== value || getError(`must not equal`);
    case Operator.lessThan:
      return compareOrderedValues(fieldValue, value, 'lt') || getError(`must be less than`);
    case Operator.lessThanEquals:
      return (
        compareOrderedValues(fieldValue, value, 'lte') || getError(`must be less than or equal to`)
      );
    case Operator.greaterThan:
      return compareOrderedValues(fieldValue, value, 'gt') || getError(`must be greater than`);
    case Operator.greaterThanEquals:
      return (
        compareOrderedValues(fieldValue, value, 'gte') ||
        getError(`must be greater than or equal to`)
      );
    case Operator.in:
      return (Array.isArray(value) && value.includes(fieldValue)) || getError(`must be one of`);
    case Operator.notIn:
      return !Array.isArray(value) || !value.includes(fieldValue) || getError(`must not be one of`);
    case Operator.contains:
      return containsValue(fieldValue, value) || getError(`must contain`);
    case Operator.notContains:
      return !containsValue(fieldValue, value) || getError(`must not contain`);
    case Operator.matches:
      return (
        (hasMatch(fieldValue) &&
          (value instanceof RegExp || typeof value === 'string') &&
          !!fieldValue.match(value)) ||
        getError(`must match pattern`)
      );
    case Operator.notMatches:
      return (
        !hasMatch(fieldValue) ||
        !(value instanceof RegExp || typeof value === 'string') ||
        !fieldValue.match(value) ||
        getError(`must not match pattern`)
      );
    case Operator.between: {
      const range = normalizeRange(value);
      if (!range) throw new Error('between operator requires an array of two values');
      if (!isOrderedValue(fieldValue)) return getError(`must be between`);
      const comparableFieldValue = toOrderedPrimitive(fieldValue);
      const [min, max] = range;
      return (
        (comparableFieldValue >= min && comparableFieldValue <= max) || getError(`must be between`)
      );
    }
    case Operator.notBetween: {
      const range = normalizeRange(value);
      if (!range) throw new Error('notBetween operator requires an array of two values');
      if (!isOrderedValue(fieldValue)) return true;
      const comparableFieldValue = toOrderedPrimitive(fieldValue);
      const [min, max] = range;
      return (
        comparableFieldValue < min || comparableFieldValue > max || getError(`must not be between`)
      );
    }
    case Operator.isEmpty:
      return isEmptyValue(fieldValue) || getError(`must be empty`);
    case Operator.notEmpty:
      return !isEmptyValue(fieldValue) || getError(`must not be empty`);
    case Operator.exists:
      return fieldValue !== undefined || getError(`must exist`);
    case Operator.notExists:
      return fieldValue === undefined || getError(`must not exist`);
    case Operator.startsWith:
      return (
        (typeof fieldValue === 'string' &&
          typeof value === 'string' &&
          fieldValue.startsWith(value)) ||
        getError(`must start with`)
      );
    case Operator.endsWith:
      return (
        (typeof fieldValue === 'string' &&
          typeof value === 'string' &&
          fieldValue.endsWith(value)) ||
        getError(`must end with`)
      );
    default:
      throw new Error('Unknown operator');
  }
};

const getValue = <TData extends Record<string, unknown>>(
  condition: Rule,
  data: TData,
  context: TData,
  bindings?: Record<string, RuleValue>,
): unknown => {
  if (condition.value !== undefined) return condition.value;
  if (condition.bind !== undefined) {
    // Key presence is the contract: an unsupplied binding is a caller bug (a
    // forgotten scope must never silently run). A supplied-but-nullish binding is
    // a value — normalize undefined → null (a legit fail-closed filter).
    if (!bindings || !(condition.bind in bindings))
      throw new Error(`Missing binding for "${condition.bind}"`);
    const bound = bindings[condition.bind];
    return bound === undefined ? null : bound;
  }
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

type OrderedValue = string | number | Date;

const isOrderedValue = (value: unknown): value is OrderedValue =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;

const toOrderedPrimitive = (value: OrderedValue): string | number =>
  value instanceof Date ? value.getTime() : value;

const compareOrderedValues = (
  left: unknown,
  right: unknown,
  operator: 'lt' | 'lte' | 'gt' | 'gte',
): boolean => {
  if (!isOrderedValue(left) || !isOrderedValue(right)) return false;

  const lhs = toOrderedPrimitive(left);
  const rhs = toOrderedPrimitive(right);

  switch (operator) {
    case 'lt':
      return lhs < rhs;
    case 'lte':
      return lhs <= rhs;
    case 'gt':
      return lhs > rhs;
    case 'gte':
      return lhs >= rhs;
  }
};

const hasMatch = (value: unknown): value is string => typeof value === 'string';

const normalizeRange = (value: unknown): [string | number, string | number] | null => {
  if (!Array.isArray(value) || value.length !== 2) return null;

  const [rawMin, rawMax] = value;
  if (!isOrderedValue(rawMin) || !isOrderedValue(rawMax)) return null;

  const min = toOrderedPrimitive(rawMin);
  const max = toOrderedPrimitive(rawMax);
  return min <= max ? [min, max] : [max, min];
};

const containsValue = (container: unknown, search: unknown): boolean => {
  if (typeof container === 'string') {
    return typeof search === 'string' && container.includes(search);
  }

  if (Array.isArray(container)) {
    return container.includes(search);
  }

  return false;
};
