import { isEqual } from 'lodash-es';
import { parseDateValue, resolveDateConfig } from './date';
import { DEFAULT_ZONE } from './dateExpr';
import { resolveCaseInsensitive, resolveFuzzy } from './engineGlobals';
import { fuzzyContains } from './fuzzy';
import { bigIntToNumber, isOrderedValue, orderPair, readSet } from './number';
import { addOffset, offsetAmount } from './offset';
import { Operator } from './operator';
import {
  EQUALITY_OPERATORS,
  type FieldKind,
  NEGATED_OPERATORS,
  NO_VALUE_OPERATORS,
  NUMERIC_KINDS,
  OPERAND_OPERATORS,
  RANGE_OPERATORS,
} from './operatorCatalog';
import { readPattern } from './pattern';
import { readField, type Scopes } from './scope';
import { showValue } from './showValue';
import type { DateConfig, OrderedRuleValue, Rule, RuleValue } from './types';
import { readValueSource } from './valueSource';

// A value is "empty" iff it is null, undefined, the empty string, or an empty array — as the
// compilers read a column, a Json value and a list. (lodash isEmpty would also treat Dates and
// numbers as empty, which breaks soft-delete grants like `deletedAt isEmpty`.)
const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/**
 * Nothing to compare against — no row matches on any rail, as SQL's NULL comparison and
 * arithmetic never do: an ordered, string, pattern or set comparison or a range that reads
 * nothing (or a range missing an end), or an offset that moved nothing. `equals` / `notEquals`
 * against a plain null stay the is-null sentinel.
 */
export const hasNoOperand = (rule: Pick<Rule, 'operator' | 'offset'>, value: unknown): boolean => {
  const missing = value === null || value === undefined;
  if (missing && (rule.offset !== undefined || OPERAND_OPERATORS.includes(rule.operator)))
    return true;
  if (!RANGE_OPERATORS.includes(rule.operator)) return false;
  return (
    missing || (Array.isArray(value) && value.some((end) => end === null || end === undefined))
  );
};

/** A field rule that only asks whether its field is there: existence or emptiness, or equality
 *  with a null literal. */
export const isExistenceTest = (
  rule: Pick<Rule, 'operator' | 'value' | 'path' | 'bind'>,
): boolean =>
  NO_VALUE_OPERATORS.includes(rule.operator) ||
  (EQUALITY_OPERATORS.includes(rule.operator) &&
    rule.value === null &&
    rule.path === undefined &&
    rule.bind === undefined);

// A bigint compares as a number (refused past the safe range).
const fromBigInt = (value: unknown): unknown => {
  if (typeof value === 'bigint') return bigIntToNumber(value);
  return Array.isArray(value) && value.some((v) => typeof v === 'bigint')
    ? value.map((v) => (typeof v === 'bigint' ? bigIntToNumber(v) : v))
    : value;
};

// Mirrors the server-side coerceValueForField contract: null/undefined pass through
// (the is-null sentinel is valid on every field), arrays coerce element-wise, unknown
// kinds pass through, and an uncoercible value returns unchanged so the comparison
// fails with the rule's normal error instead of throwing on one dirty row.
const coerceScalar = (value: unknown, kind: FieldKind, zone: string): unknown => {
  if (value === null || value === undefined) return value;

  if (NUMERIC_KINDS.includes(kind)) {
    if (typeof value !== 'string' || value.trim() === '') return value;
    // A BigInt digit string past the safe range would round: refuse it, as for a bigint.
    if (kind === 'BigInt' && /^-?\d+$/.test(value.trim()))
      return bigIntToNumber(BigInt(value.trim()));
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }

  switch (kind) {
    case 'DateTime': {
      // Everything lands on epoch ms so equals/ordered compare across Date instances, ISO
      // strings and ms-timestamp strings. A zoneless string anchors in the evaluation's zone,
      // through the date rail's own parser.
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number') return value;
      if (typeof value !== 'string') return value;
      const parsed = parseDateValue(value, zone);
      return parsed.isValid() ? parsed.valueOf() : value;
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

/** A value coerced to a field kind; a zoneless DateTime string anchors in `zone`. */
export const applyCoercion = (
  value: unknown,
  kind: FieldKind | undefined,
  zone: string = DEFAULT_ZONE,
): unknown => {
  if (kind === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => coerceScalar(item, kind, zone));
  return coerceScalar(value, kind, zone);
};

export const checkField = (
  condition: Rule,
  scopes: Scopes,
  context: unknown,
  bindings?: Record<string, RuleValue>,
  config: DateConfig = {},
  // A computed left-hand side (an aggregate) in place of the field's value.
  computed?: { value: unknown },
): boolean | string => {
  const raw = computed ? computed.value : (readField(condition.field, scopes) ?? null);
  // A Date compares as DateTime even unstamped, as the compilers read a DateTime column.
  const kind = condition.coerceType ?? (raw instanceof Date ? 'DateTime' : undefined);
  // Only a DateTime coercion reads the zone.
  const zone =
    kind === 'DateTime'
      ? resolveDateConfig(config, (source) => readValueSource(source, scopes, context, bindings))
          .timeZone
      : DEFAULT_ZONE;
  // An absent path reads as NULL, as a column does on the compiled rails.
  const fieldValue = applyCoercion(fromBigInt(raw), kind, zone);

  // Operators that don't need a value
  const needsValue = !NO_VALUE_OPERATORS.includes(condition.operator);
  const value = needsValue
    ? shift(
        applyCoercion(
          fromBigInt(readValueSource(condition, scopes, context, bindings) ?? null),
          kind,
          zone,
        ),
        condition,
        scopes,
        context,
        bindings,
      )
    : undefined;

  if (needsValue && hasNoOperand(condition, value)) {
    if (NEGATED_OPERATORS.includes(condition.operator) && fieldValue == null) return true;
    return condition.error || `${condition.field} has no comparison value`;
  }

  const getError = (op: string) =>
    condition.error || `${condition.field} ${op}${needsValue ? ` ${showValue(value)}` : ''}`;

  const ci = resolveCaseInsensitive(condition.caseInsensitive);
  const lower = (v: unknown): unknown => (ci && typeof v === 'string' ? v.toLowerCase() : v);
  const lhs = lower(fieldValue);
  const rhs = Array.isArray(value) ? value.map(lower) : lower(value);

  // Fuzzy applies to containment search: typo-tolerant token match over strings, else the
  // exact containment check. fuzzyContains lowercases internally, so it's case-insensitive. A
  // list contains a member exactly: case-insensitivity matches text, not membership.
  const fuzzy = resolveFuzzy(condition.fuzzy);
  const containsMatch = (): boolean =>
    fuzzy && typeof fieldValue === 'string' && typeof value === 'string'
      ? fuzzyContains(fieldValue, value, fuzzy)
      : Array.isArray(fieldValue)
        ? fieldValue.some((item) => isEqual(item, value))
        : containsValue(lhs, rhs);

  switch (condition.operator) {
    // Values compare as JSON does: by value (a list or an object deeply), never across types.
    case Operator.equals:
      return isEqual(lhs, rhs) || getError(`must equal`);
    case Operator.notEquals:
      return !isEqual(lhs, rhs) || getError(`must not equal`);
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
      return readSet(rhs).some((item) => isEqual(item, lhs)) || getError(`must be one of`);
    case Operator.notIn:
      return !readSet(rhs).some((item) => isEqual(item, lhs)) || getError(`must not be one of`);
    case Operator.contains:
      return containsMatch() || getError(`must contain`);
    case Operator.notContains:
      return !containsMatch() || getError(`must not contain`);
    case Operator.matches:
      return (
        (hasMatch(fieldValue) && isPattern(value) && readPattern(value).test(fieldValue)) ||
        getError(`must match pattern`)
      );
    case Operator.notMatches:
      return (
        !hasMatch(fieldValue) ||
        !isPattern(value) ||
        !readPattern(value).test(fieldValue) ||
        getError(`must not match pattern`)
      );
    case Operator.between: {
      const range = normalizeRange(value);
      if (!range) throw new Error('between operator requires an array of two values');
      if (!inRangeOrder(fieldValue, range)) return getError(`must be between`);
      const comparableFieldValue = toOrderedPrimitive(fieldValue);
      const [min, max] = range;
      return (
        (comparableFieldValue >= min && comparableFieldValue <= max) || getError(`must be between`)
      );
    }
    case Operator.notBetween: {
      const range = normalizeRange(value);
      if (!range) throw new Error('notBetween operator requires an array of two values');
      if (!inRangeOrder(fieldValue, range)) return true;
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

const toOrderedPrimitive = (value: OrderedRuleValue): string | number =>
  value instanceof Date ? value.getTime() : value;

const compareOrderedValues = (
  left: unknown,
  right: unknown,
  operator: 'lt' | 'lte' | 'gt' | 'gte',
): boolean => {
  if (!sameOrder(left, right) || !isOrderedValue(right)) return false;

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

const isPattern = (value: unknown): value is string | RegExp =>
  typeof value === 'string' || value instanceof RegExp;

const normalizeRange = (value: unknown): [string | number, string | number] | null => {
  if (!Array.isArray(value) || value.length !== 2) return null;

  const [rawMin, rawMax] = value;
  if (!isOrderedValue(rawMin) || !isOrderedValue(rawMax)) return null;

  return orderPair([toOrderedPrimitive(rawMin), toOrderedPrimitive(rawMax)]);
};

const containsValue = (container: unknown, search: unknown): boolean =>
  typeof container === 'string' && typeof search === 'string' && container.includes(search);

/** Two values that order against each other: both numbers, both strings, or both dates. */
const sameOrder = (a: unknown, b: unknown): a is OrderedRuleValue =>
  isOrderedValue(a) && isOrderedValue(b) && orderKind(a) === orderKind(b);

const orderKind = (value: OrderedRuleValue | number | string): string =>
  value instanceof Date ? 'date' : typeof value;

/** A field that orders against a range's ends (already reduced to primitives). */
const inRangeOrder = (
  value: unknown,
  range: [string | number, string | number],
): value is OrderedRuleValue =>
  isOrderedValue(value) && typeof toOrderedPrimitive(value) === typeof range[0];
