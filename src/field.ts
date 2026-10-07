import { resolveCaseInsensitive, resolveFuzzy } from './engineGlobals';
import { fuzzyContains } from './fuzzy';
import { Operator } from './operator';
import type { FieldKind } from './operatorCatalog';
import { readField, type Scopes } from './scope';
import type { Rule, RuleValue } from './types';
import { addOffset, bigIntToNumber, offsetAmount, readValueSource } from './valueSource';

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
export const NUMERIC_COERCE_KINDS: readonly FieldKind[] = ['Int', 'BigInt', 'Float', 'Decimal'];

// A datetime string with a time part but no explicit zone (no trailing Z / ±HH:MM).
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const fromBigInt = (value: unknown): unknown => {
  if (typeof value === 'bigint') return bigIntToNumber(value);
  return Array.isArray(value) && value.some((v) => typeof v === 'bigint')
    ? value.map((v) => (typeof v === 'bigint' ? bigIntToNumber(v) : v))
    : value;
};

const coerceScalar = (value: unknown, kind: FieldKind): unknown => {
  if (value === null || value === undefined) return value;

  if (NUMERIC_COERCE_KINDS.includes(kind)) {
    if (typeof value !== 'string' || value.trim() === '') return value;
    // A BigInt digit string past the safe range would round: refuse it, as for a bigint.
    if (kind === 'BigInt' && /^-?\d+$/.test(value.trim()))
      return bigIntToNumber(BigInt(value.trim()));
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

export const applyCoercion = (value: unknown, kind: FieldKind | undefined): unknown => {
  if (kind === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => coerceScalar(item, kind));
  return coerceScalar(value, kind);
};

export const checkField = (
  condition: Rule,
  scopes: Scopes,
  context: unknown,
  bindings?: Record<string, RuleValue>,
): boolean | string => {
  const fieldValue = applyCoercion(
    fromBigInt(readField(condition.field, scopes)),
    condition.coerceType,
  );

  // Operators that don't need a value
  const noValueOps: Operator[] = [
    Operator.isEmpty,
    Operator.notEmpty,
    Operator.exists,
    Operator.notExists,
  ];
  const needsValue = !noValueOps.includes(condition.operator);
  const value = needsValue
    ? shift(
        applyCoercion(
          fromBigInt(readValueSource(condition, scopes, context, bindings)),
          condition.coerceType,
        ),
        condition,
        scopes,
        context,
        bindings,
      )
    : undefined;

  // An offset moved nothing: the comparison fails closed, as SQL's NULL arithmetic does. A
  // negation still keeps a null field (the 2.19.0 ruling).
  if (condition.offset !== undefined && (value === null || value === undefined)) {
    const negated =
      condition.operator === Operator.notEquals || condition.operator === Operator.notBetween;
    if (negated && (fieldValue === null || fieldValue === undefined)) return true;
    return condition.error || `${condition.field} has no comparison value`;
  }

  const getError = (op: string) =>
    condition.error || `${condition.field} ${op}${needsValue ? ` ${JSON.stringify(value)}` : ''}`;

  const ci = resolveCaseInsensitive(condition.caseInsensitive);
  const lhs = ci && typeof fieldValue === 'string' ? fieldValue.toLowerCase() : fieldValue;
  const rhs = ci && typeof value === 'string' ? value.toLowerCase() : value;

  // Fuzzy applies to containment search: typo-tolerant token match over strings, else the
  // exact containment check. fuzzyContains lowercases internally, so it's case-insensitive.
  const fuzzy = resolveFuzzy(condition.fuzzy);
  const containsMatch = (): boolean =>
    fuzzy && typeof fieldValue === 'string' && typeof value === 'string'
      ? fuzzyContains(fieldValue, value, fuzzy)
      : containsValue(lhs, rhs);

  switch (condition.operator) {
    case Operator.equals:
      return lhs === rhs || getError(`must equal`);
    case Operator.notEquals:
      return lhs !== rhs || getError(`must not equal`);
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
      return containsMatch() || getError(`must contain`);
    case Operator.notContains:
      return !containsMatch() || getError(`must not contain`);
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
      return fieldValue != null || getError(`must exist`);
    case Operator.notExists:
      return fieldValue == null || getError(`must not exist`);
    case Operator.startsWith:
      return (
        (typeof lhs === 'string' && typeof rhs === 'string' && lhs.startsWith(rhs)) ||
        getError(`must start with`)
      );
    case Operator.endsWith:
      return (
        (typeof lhs === 'string' && typeof rhs === 'string' && lhs.endsWith(rhs)) ||
        getError(`must end with`)
      );
    default:
      throw new Error('Unknown operator');
  }
};

const shift = (
  value: unknown,
  condition: Rule,
  scopes: Scopes,
  context: unknown,
  bindings?: Record<string, RuleValue>,
): unknown => {
  if (condition.offset === undefined) return value;
  const amount = offsetAmount(readValueSource(condition.offset, scopes, context, bindings));
  return amount === null ? null : addOffset(value, amount);
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
