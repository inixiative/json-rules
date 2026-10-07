import { isPlainObject as isPlainObjectLodash } from 'lodash-es';
import { isDateInputValue, parseDateValue } from './date';
import { DEFAULT_ZONE, isDateExpr, isEdgeExpr, isPeriodExpr, isRollingExpr } from './dateExpr';
import { ArrayOperator, type DateOperator, type Operator } from './operator';
import {
  ARRAY_OPERATOR_CATALOG,
  DATE_OPERATOR_CATALOG,
  DAY_NAMES,
  FIELD_OPERATOR_CATALOG,
  FieldKind,
  getAggregateOperators,
  getValueShape,
  isAggregateRangeOperator,
  isAggregateSingleOperator,
  isCalendarUnit,
  isDayName,
  isOperatorSupportedForTarget,
  isRelativeUnit,
  OFFSET_OPERATORS,
  PERIOD_UNITS,
  RANGE_OPERATORS,
  type RuleTarget,
  type ValueShape,
  WINDOW_OPERATORS,
} from './operatorCatalog';
import { parseScopeRef, scopeOutOfBounds } from './scope';
import type { ArrayRule, Condition, DateExpr, OrderedRuleValue } from './types';
import { rowRef, SOURCE_FORMS } from './valueSource';
import { extremalRewrite } from './window';

export type ValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
};

type ValidationContext = {
  target: RuleTarget;
  errors: ValidationIssue[];
};

const FIELD_OPERATORS = new Set<string>(Object.keys(FIELD_OPERATOR_CATALOG));
const ARRAY_OPERATORS = new Set<string>(Object.keys(ARRAY_OPERATOR_CATALOG));
const DATE_OPERATORS = new Set<string>(Object.keys(DATE_OPERATOR_CATALOG));

export const validateRule = (
  condition: unknown,
  options: { target?: RuleTarget } = {},
): ValidationResult => {
  const context: ValidationContext = {
    target: options.target ?? 'check',
    errors: [],
  };

  validateCondition(condition, '$', context, 1);
  return { ok: context.errors.length === 0, errors: context.errors };
};

export const assertValidRule = (
  condition: unknown,
  options: { target?: RuleTarget } = {},
): asserts condition is Condition => {
  const result = validateRule(condition, options);
  if (result.ok) return;

  const message = result.errors.map((error) => `${error.path}: ${error.message}`).join('\n');
  throw new Error(`Invalid rule:\n${message}`);
};

const validateCondition = (
  condition: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (typeof condition === 'boolean') {
    if (context.target === 'toPrisma' && condition === false) {
      pushIssue(
        context,
        path,
        'boolean_false_not_supported',
        `Boolean 'false' is not supported by toPrisma()`,
      );
    }
    return;
  }

  if (!isPlainObject(condition)) {
    pushIssue(context, path, 'invalid_condition', 'Condition must be a boolean or object');
    return;
  }

  const shape = detectShape(condition);
  if (!shape) {
    pushIssue(
      context,
      path,
      'ambiguous_condition',
      'Condition must be exactly one of: field rule, array rule, date rule, all, any, or if/then[/else]',
    );
    return;
  }

  switch (shape) {
    case 'all':
      validateLogicalArray(condition.all, `${path}.all`, context, depth);
      break;
    case 'any':
      validateLogicalArray(condition.any, `${path}.any`, context, depth);
      break;
    case 'if':
      validateCondition(condition.if, `${path}.if`, context, depth);
      validateCondition(condition.then, `${path}.then`, context, depth);
      if ('else' in condition && condition.else !== undefined) {
        validateCondition(condition.else, `${path}.else`, context, depth);
      }
      break;
    case 'field':
      validateFieldRule(condition, path, context, depth);
      break;
    case 'aggregate':
      validateAggregateRule(condition, path, context, depth);
      break;
    case 'array':
      validateArrayRule(condition, path, context, depth);
      break;
    case 'date':
      validateDateRule(condition, path, context, depth);
      break;
  }
};

const detectShape = (
  condition: Record<string, unknown>,
): 'all' | 'any' | 'if' | 'field' | 'aggregate' | 'array' | 'date' | null => {
  const shapes: string[] = [];
  if ('all' in condition) shapes.push('all');
  if ('any' in condition) shapes.push('any');
  if ('if' in condition || 'then' in condition || 'else' in condition) shapes.push('if');
  if ('arrayOperator' in condition) shapes.push('array');
  if ('dateOperator' in condition) shapes.push('date');
  if ('aggregate' in condition) shapes.push('aggregate');
  else if ('operator' in condition) shapes.push('field');

  const uniqueShapes = Array.from(new Set(shapes));
  if (uniqueShapes.length !== 1) return null;
  return uniqueShapes[0] as 'all' | 'any' | 'if' | 'field' | 'aggregate' | 'array' | 'date';
};

const validateLogicalArray = (
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (!Array.isArray(value)) {
    pushIssue(
      context,
      path,
      'logical_array_required',
      'Logical operator requires an array of conditions',
    );
    return;
  }

  value.forEach((item, index) => {
    validateCondition(item, `${path}[${index}]`, context, depth);
  });
};

const validateField = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (typeof rule.field === 'string')
    validateRef(rule.field, 'field', `${path}.field`, context, depth);
};

const validateRef = (
  ref: string,
  key: 'field' | 'path',
  issuePath: string,
  context: ValidationContext,
  depth: number,
): void => {
  const parsed = parseScopeRef(ref);
  if (!parsed) return;
  const label = key === 'field' ? 'Field' : 'Path';
  if (parsed.depth > depth) {
    pushIssue(
      context,
      issuePath,
      'scope_out_of_bounds',
      scopeOutOfBounds(ref, parsed.depth, depth),
    );
  }
  if (context.target === 'toPrisma') {
    pushIssue(
      context,
      issuePath,
      `unsupported_prisma_${key}`,
      `${label} '${ref}' is not supported by toPrisma()`,
    );
  } else if (context.target === 'toSql' && (key === 'field' || parsed.depth > 1)) {
    pushIssue(
      context,
      issuePath,
      `unsupported_sql_${key}`,
      `${label} '${ref}' is not supported by toSql()`,
    );
  }
};

type SourceForm = (typeof SOURCE_FORMS)[number];

// One value source — `{ value } | { path } | { bind }` — wherever it appears: a rule's comparison
// value, an offset, a unit amount. Exactly one form; `bindOptional` only beside `bind`; a path is
// gated like any ref. Returns the form, or null when it is malformed.
const validateSource = (
  source: Record<string, unknown>,
  at: string,
  context: ValidationContext,
  depth: number,
): SourceForm | null => {
  const forms = SOURCE_FORMS.filter((form) => source[form] !== undefined);
  if (forms.length > 1) {
    pushIssue(context, at, 'ambiguous_value_source', 'Takes one of value, path or bind');
    return null;
  }
  if (forms.length === 0) {
    pushIssue(context, at, 'missing_value_source', 'Requires value, path or bind');
    return null;
  }
  const [form] = forms;
  if (form !== 'value' && (typeof source[form] !== 'string' || source[form] === '')) {
    pushIssue(context, `${at}.${form}`, 'invalid_value_source', `${form} is a non-empty string`);
    return null;
  }
  if (
    source.bindOptional !== undefined &&
    (form !== 'bind' || typeof source.bindOptional !== 'boolean')
  )
    pushIssue(
      context,
      `${at}.bindOptional`,
      'invalid_value_source',
      'bindOptional is a boolean beside bind',
    );
  if (form === 'path') validateRef(source.path as string, 'path', `${at}.path`, context, depth);
  return form;
};

// An offset moves the comparison value by what its own value source reads: a number on a field
// rule, a rolling `{ ago }` / `{ ahead }` on a date rule. A date offset read per row is check-only.
const validateOffset = (
  rule: Record<string, unknown>,
  kind: 'field' | 'date',
  operator: string,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  const { offset } = rule;
  if (offset === undefined) return;
  const at = `${path}.offset`;
  if (!OFFSET_OPERATORS.includes(operator)) {
    pushIssue(
      context,
      at,
      'unsupported_offset_operator',
      `Operator '${operator}' has no comparison point to offset`,
    );
    return;
  }
  if (!isPlainObject(offset)) {
    pushIssue(context, at, 'invalid_offset', 'An offset is one of { value }, { path } or { bind }');
    return;
  }
  const form = validateSource(offset, at, context, depth);
  if (form === 'path') {
    const ref = offset.path as string;
    const scoped = rowRef(offset);
    if (kind === 'date' && scoped && scoped.depth <= 1 && context.target === 'toSql')
      pushIssue(
        context,
        `${at}.path`,
        'unsupported_sql_path',
        `A row path on a date offset ('${ref}') is not supported by toSql()`,
      );
    return;
  }
  if (form !== 'value') return;
  const value = offset.value;
  if (kind === 'field') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      pushIssue(context, `${at}.value`, 'invalid_offset', 'A field offset value is a number');
    return;
  }
  const units = isPlainObject(value) ? Object.keys(value) : [];
  if (units.length !== 1 || (units[0] !== 'ago' && units[0] !== 'ahead')) {
    pushIssue(
      context,
      `${at}.value`,
      'invalid_offset',
      'A date offset value is { ago } or { ahead }',
    );
    return;
  }
  validateRelativeUnits(
    (value as Record<string, unknown>)[units[0]],
    `${at}.value.${units[0]}`,
    context,
    depth,
  );
};

// A range read from a row column is a scalar, not a pair: toSql has no form for it.
const rejectSqlRowRange = (
  rule: Record<string, unknown>,
  operator: string,
  path: string,
  context: ValidationContext,
): void => {
  if (context.target !== 'toSql' || !RANGE_OPERATORS.includes(operator)) return;
  if (!rowRef(rule)) return;
  pushIssue(
    context,
    `${path}.path`,
    'unsupported_sql_path',
    `A range read from the row ('${rule.path}') is not supported by toSql()`,
  );
};

const validateFieldRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (typeof rule.field !== 'string') {
    pushIssue(context, `${path}.field`, 'field_required', 'Field rule requires a string field');
  }
  validateField(rule, path, context, depth);
  if (rule.offset !== undefined && 'aggregate' in rule) {
    pushIssue(context, `${path}.offset`, 'unexpected_offset', 'Aggregate rules take no offset');
  }

  if (typeof rule.operator !== 'string' || !FIELD_OPERATORS.has(rule.operator)) {
    pushIssue(context, `${path}.operator`, 'invalid_operator', 'Unknown field operator');
    return;
  }

  const operator = rule.operator as Operator;
  validateOffset(rule, 'field', operator, path, context, depth);

  if (!isOperatorSupportedForTarget(operator, context.target)) {
    pushIssue(
      context,
      `${path}.operator`,
      `unsupported_${targetSlug(context.target)}_operator`,
      `Operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  if (
    rule.coerceType !== undefined &&
    !(typeof rule.coerceType === 'string' && Object.hasOwn(FieldKind, rule.coerceType))
  ) {
    pushIssue(
      context,
      `${path}.coerceType`,
      'invalid_coerce_type',
      `coerceType must be one of: ${Object.keys(FieldKind).join(', ')}`,
    );
  }

  const shape = getValueShape(operator);

  if (shape === 'none') {
    forbidValueAndPath(rule, path, context);
    return;
  }

  if (validateSource(rule, path, context, depth) === null) return;
  rejectSqlRowRange(rule, operator, path, context);
  if (typeof rule.path === 'string' || typeof rule.bind === 'string') return;

  validateValueShape(shape, rule.value, operator, `${path}.value`, context);
};

const validateValueShape = (
  shape: ValueShape,
  value: unknown,
  operator: string,
  path: string,
  context: ValidationContext,
): void => {
  switch (shape) {
    case 'scalar':
    case 'string':
      if (shape === 'string' && typeof value !== 'string') {
        pushIssue(
          context,
          path,
          'invalid_string_value',
          `Operator '${operator}' requires a string value`,
        );
      }
      return;
    case 'ordered':
      if (!isOrderedRuleValue(value)) {
        pushIssue(
          context,
          path,
          'invalid_ordered_value',
          `Operator '${operator}' requires a string, number, or Date value`,
        );
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        pushIssue(
          context,
          path,
          'invalid_membership_value',
          `Operator '${operator}' requires an array value`,
        );
      }
      return;
    case 'pattern':
      if (!(typeof value === 'string' || value instanceof RegExp)) {
        pushIssue(
          context,
          path,
          'invalid_pattern_value',
          `Operator '${operator}' requires a string or RegExp value`,
        );
      }
      return;
    case 'range':
      if (!isOrderedRange(value)) {
        pushIssue(
          context,
          path,
          'invalid_range_value',
          `Operator '${operator}' requires a two-item range`,
        );
      }
      return;
  }
};

const validateAggregateRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  validateWindow(rule, path, context, depth);

  if (typeof rule.field !== 'string') {
    pushIssue(context, `${path}.field`, 'field_required', 'Aggregate rule requires a string field');
  }
  validateField(rule, path, context, depth);

  if (!isPlainObject(rule.aggregate)) {
    pushIssue(context, `${path}.aggregate`, 'invalid_aggregate', 'aggregate must be an object');
    return;
  }

  const agg = rule.aggregate as Record<string, unknown>;
  if (agg.mode !== 'sum' && agg.mode !== 'avg') {
    pushIssue(
      context,
      `${path}.aggregate.mode`,
      'invalid_aggregate_mode',
      "aggregate.mode must be 'sum' or 'avg'",
    );
  }

  if ('field' in agg && agg.field !== undefined && typeof agg.field !== 'string') {
    pushIssue(
      context,
      `${path}.aggregate.field`,
      'invalid_aggregate_field',
      'aggregate.field must be a string',
    );
  }

  const isSingle =
    typeof rule.operator === 'string' && isAggregateSingleOperator(rule.operator as Operator);
  const isRange =
    typeof rule.operator === 'string' && isAggregateRangeOperator(rule.operator as Operator);

  if (!isSingle && !isRange) {
    pushIssue(
      context,
      `${path}.operator`,
      'invalid_aggregate_operator',
      `Aggregate rules only support: equals, notEquals, lessThan, lessThanEquals, greaterThan, greaterThanEquals, between, notBetween`,
    );
    return;
  }

  if (!getAggregateOperators(context.target).includes(rule.operator as Operator)) {
    pushIssue(
      context,
      `${path}.operator`,
      `unsupported_${targetSlug(context.target)}_aggregate_operator`,
      `Operator '${rule.operator}' is not supported by ${context.target}() for aggregate rules`,
    );
  }

  if (context.target === 'toPrisma' && typeof rule.path === 'string') {
    pushIssue(
      context,
      `${path}.path`,
      'unsupported_prisma_aggregate_path',
      `path is not supported by toPrisma() for aggregate rules; use value instead`,
    );
  }

  if ('condition' in rule && rule.condition !== undefined) {
    if (context.target === 'toSql') {
      pushIssue(
        context,
        `${path}.condition`,
        'unsupported_sql_aggregate_condition',
        `Aggregate condition filtering is not supported by toSql(); use check() or toPrisma()`,
      );
    }
    validateCondition(rule.condition, `${path}.condition`, context, depth + 1);
  }

  if (validateSource(rule, path, context, depth) === null) return;
  if (typeof rule.path === 'string' || typeof rule.bind === 'string') return;

  const value = rule.value;
  if (isRange) {
    if (!isNumericRange(value)) {
      pushIssue(
        context,
        `${path}.value`,
        'invalid_range_value',
        `Operator '${rule.operator}' requires a two-item numeric range`,
      );
    }
  } else {
    if (typeof value !== 'number') {
      pushIssue(
        context,
        `${path}.value`,
        'invalid_aggregate_value',
        `Aggregate rule value must be a number`,
      );
    }
  }
};

const validateArrayRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (typeof rule.field !== 'string') {
    if (context.target !== 'check') {
      pushIssue(
        context,
        `${path}.field`,
        'field_required',
        'Array rule requires a string field for this target',
      );
    }
  }
  validateField(rule, path, context, depth);

  validateWindow(rule, path, context, depth);

  if (typeof rule.arrayOperator !== 'string' || !ARRAY_OPERATORS.has(rule.arrayOperator)) {
    pushIssue(context, `${path}.arrayOperator`, 'invalid_array_operator', 'Unknown array operator');
    return;
  }

  const operator = rule.arrayOperator as ArrayOperator;

  if (!isOperatorSupportedForTarget(operator, context.target)) {
    pushIssue(
      context,
      `${path}.arrayOperator`,
      `unsupported_${targetSlug(context.target)}_array_operator`,
      `Array operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  switch (operator) {
    case ArrayOperator.empty:
    case ArrayOperator.notEmpty:
      if ('condition' in rule && rule.condition !== undefined) {
        pushIssue(
          context,
          `${path}.condition`,
          'unexpected_condition',
          `Array operator '${operator}' does not accept condition`,
        );
      }
      if ('count' in rule && rule.count !== undefined) {
        pushIssue(
          context,
          `${path}.count`,
          'unexpected_count',
          `Array operator '${operator}' does not accept count`,
        );
      }
      break;
    case ArrayOperator.all:
    case ArrayOperator.any:
    case ArrayOperator.none:
      if (!('condition' in rule) || rule.condition === undefined) {
        pushIssue(
          context,
          `${path}.condition`,
          'missing_condition',
          `Array operator '${operator}' requires condition`,
        );
      } else {
        validateCondition(rule.condition, `${path}.condition`, context, depth + 1);
      }
      if ('count' in rule && rule.count !== undefined) {
        pushIssue(
          context,
          `${path}.count`,
          'unexpected_count',
          `Array operator '${operator}' does not accept count`,
        );
      }
      break;
    case ArrayOperator.atLeast:
    case ArrayOperator.atMost:
    case ArrayOperator.exactly:
      if (context.target !== 'toPrisma' && typeof rule.count !== 'number') {
        pushIssue(
          context,
          `${path}.count`,
          'missing_count',
          `Array operator '${operator}' requires count`,
        );
      } else if ('count' in rule && rule.count !== undefined && typeof rule.count !== 'number') {
        pushIssue(context, `${path}.count`, 'invalid_count', 'count must be a number');
      }
      if (context.target === 'check' && (!('condition' in rule) || rule.condition === undefined)) {
        pushIssue(
          context,
          `${path}.condition`,
          'missing_condition',
          `Array operator '${operator}' requires condition for check()`,
        );
      } else if ('condition' in rule && rule.condition !== undefined) {
        validateCondition(rule.condition, `${path}.condition`, context, depth + 1);
      }
      break;
  }
};

const validateDateRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (typeof rule.field !== 'string') {
    pushIssue(context, `${path}.field`, 'field_required', 'Date rule requires a string field');
  }
  validateField(rule, path, context, depth);

  if (typeof rule.dateOperator !== 'string' || !DATE_OPERATORS.has(rule.dateOperator)) {
    pushIssue(context, `${path}.dateOperator`, 'invalid_date_operator', 'Unknown date operator');
    return;
  }

  const operator = rule.dateOperator as DateOperator;
  validateOffset(rule, 'date', operator, path, context, depth);

  if (!isOperatorSupportedForTarget(operator, context.target)) {
    pushIssue(
      context,
      `${path}.dateOperator`,
      `unsupported_${targetSlug(context.target)}_date_operator`,
      `Date operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  const shape = getValueShape(operator);

  if (shape === 'dayList') {
    if (validateSource(rule, path, context, depth) !== 'value') return;
    const days = rule.value;
    if (!Array.isArray(days) || !days.every((day) => typeof day === 'string' && isDayName(day)))
      pushIssue(
        context,
        `${path}.value`,
        'invalid_day_list',
        `Date operator '${operator}' requires an array of day names (${DAY_NAMES.join(', ')})`,
      );
    return;
  }

  if (validateSource(rule, path, context, depth) === null) return;
  rejectSqlRowRange(rule, operator, path, context);
  if (typeof rule.path === 'string' || typeof rule.bind === 'string') return;

  // Structured date expressions (v2.6): ago/ahead, this/last/next, start/end.
  if (isDateExpr(rule.value)) {
    validateDateExpr(rule.value, operator, `${path}.value`, context, depth);
    return;
  }

  if (WINDOW_OPERATORS.includes(operator)) {
    // The range operators only accept an expression range (period or rolling), not a literal pair.
    pushIssue(
      context,
      `${path}.value`,
      'invalid_date_range',
      `Date operator '${operator}' requires a range date expression (a period or rolling window)`,
    );
    return;
  }

  if (shape === 'dateRange') {
    if (!isDateRangeOrExprPair(rule.value)) {
      pushIssue(
        context,
        `${path}.value`,
        'invalid_date_range',
        `Date operator '${operator}' requires a two-item date range`,
      );
      return;
    }
    (rule.value as unknown[]).forEach((item, i) => {
      if (isDateExpr(item)) {
        validateDateExpr(item, operator, `${path}.value[${i}]`, context, depth);
      } else if (isDateInputValue(item) && !parseDateValue(item, DEFAULT_ZONE).isValid()) {
        pushIssue(
          context,
          `${path}.value[${i}]`,
          'invalid_date_value',
          `Date operator '${operator}' value '${String(item)}' does not parse as a date`,
        );
      }
    });
    return;
  }

  if (!isDateInputValue(rule.value)) {
    pushIssue(
      context,
      `${path}.value`,
      'invalid_date_value',
      `Date operator '${operator}' requires a date-like value`,
    );
    return;
  }

  // A date-like value must actually parse — a string that survives validation but
  // fails the compilers/check() would persist clean and then fail at evaluation.
  if (!parseDateValue(rule.value, DEFAULT_ZONE).isValid()) {
    pushIssue(
      context,
      `${path}.value`,
      'invalid_date_value',
      `Date operator '${operator}' value '${String(rule.value)}' does not parse as a date`,
    );
  }
};

// --- v2.6 date-expression validation ---
const validateRelativeUnits = (
  units: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (!isPlainObject(units) || Object.keys(units).length === 0) {
    pushIssue(
      context,
      path,
      'invalid_relative_units',
      'Relative offset requires at least one unit',
    );
    return;
  }
  for (const [key, magnitude] of Object.entries(units)) {
    if (!isRelativeUnit(key)) {
      pushIssue(
        context,
        `${path}.${key}`,
        'invalid_relative_unit',
        `Unknown relative unit '${key}'`,
      );
      continue;
    }
    // An amount is a literal number or a value source; a `{ value }` is checked like a literal.
    const form = isPlainObject(magnitude)
      ? validateSource(magnitude, `${path}.${key}`, context, depth)
      : 'literal';
    if (form === null || form === 'path' || form === 'bind') continue;
    const amount = form === 'value' ? (magnitude as Record<string, unknown>).value : magnitude;
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      (isCalendarUnit(key) && !Number.isInteger(amount))
    ) {
      pushIssue(
        context,
        `${path}.${key}`,
        'invalid_relative_magnitude',
        `Relative magnitudes must be positive numbers (got ${String(amount)})`,
      );
    }
  }
};

const validatePeriodUnit = (unit: unknown, path: string, context: ValidationContext): void => {
  if (typeof unit !== 'string' || !PERIOD_UNITS.includes(unit)) {
    pushIssue(context, path, 'invalid_period_unit', `Unknown period unit '${String(unit)}'`);
  }
};

const validateDateExpr = (
  expr: DateExpr,
  operator: DateOperator,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  const isRange = WINDOW_OPERATORS.includes(operator);

  if (isRollingExpr(expr)) {
    validateRelativeUnits('ago' in expr ? expr.ago : expr.ahead, path, context, depth);
    return;
  }

  if (isPeriodExpr(expr)) {
    const unit = 'this' in expr ? expr.this : 'last' in expr ? expr.last : expr.next;
    validatePeriodUnit(unit, path, context);
    return;
  }

  if (isEdgeExpr(expr)) {
    if (isRange) {
      pushIssue(
        context,
        path,
        'invalid_date_range',
        `'${operator}' requires a range (period or rolling); a start/end edge is a single point`,
      );
      return;
    }
    const period = 'start' in expr ? expr.start : expr.end;
    if (!isPlainObject(period) || !isPeriodExpr(period)) {
      pushIssue(context, path, 'invalid_period_unit', `start/end requires a this/last/next period`);
      return;
    }
    const unit = 'this' in period ? period.this : 'last' in period ? period.last : period.next;
    validatePeriodUnit(unit, path, context);
    return;
  }

  pushIssue(context, path, 'invalid_date_expression', 'Unrecognized date expression');
};

const forbidValueAndPath = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void => {
  if ('value' in rule && rule.value !== undefined) {
    pushIssue(context, `${path}.value`, 'unexpected_value', 'Rule does not accept value');
  }
  if ('path' in rule && rule.path !== undefined) {
    pushIssue(context, `${path}.path`, 'unexpected_path', 'Rule does not accept path');
  }
  if ('bind' in rule && rule.bind !== undefined) {
    pushIssue(context, `${path}.bind`, 'unexpected_bind', 'Rule does not accept bind');
  }
};

const targetSlug = (target: RuleTarget): string =>
  target === 'toPrisma' ? 'prisma' : target === 'toSql' ? 'sql' : 'check';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObjectLodash(value);

const isOrderedRuleValue = (value: unknown): value is OrderedRuleValue =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;

const isOrderedRange = (value: unknown): value is [OrderedRuleValue, OrderedRuleValue] =>
  Array.isArray(value) &&
  value.length === 2 &&
  isOrderedRuleValue(value[0]) &&
  isOrderedRuleValue(value[1]);

const isNumericRange = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number';

const isDateRangeOrExprPair = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 2 &&
  (isDateInputValue(value[0]) || isDateExpr(value[0])) &&
  (isDateInputValue(value[1]) || isDateExpr(value[1]));

const validateWindow = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  const windowed =
    ('filter' in rule && rule.filter !== undefined) ||
    ('orderBy' in rule && rule.orderBy !== undefined) ||
    ('take' in rule && rule.take !== undefined) ||
    ('skip' in rule && rule.skip !== undefined);

  if (windowed && context.target !== 'check') {
    // toPrisma supports the extremal (take:1, aligned, unfiltered) rewrite to every/some.
    const eligible =
      context.target === 'toPrisma' && extremalRewrite(rule as unknown as ArrayRule) !== null;
    if (!eligible) {
      pushIssue(
        context,
        path,
        `unsupported_${targetSlug(context.target)}_window`,
        `Windowing (filter/orderBy/take/skip) is not supported by ${context.target}() for this rule; evaluate with check()`,
      );
    }
  }

  if ('filter' in rule && rule.filter !== undefined) {
    validateCondition(rule.filter, `${path}.filter`, context, depth + 1);
  }

  if ('orderBy' in rule && rule.orderBy !== undefined) {
    const ob = rule.orderBy;
    if (!Array.isArray(ob) || ob.length === 0) {
      pushIssue(
        context,
        `${path}.orderBy`,
        'invalid_order_by',
        'orderBy must be a non-empty array of { field, dir }',
      );
    } else {
      ob.forEach((o, i) => {
        if (
          !isPlainObject(o) ||
          typeof o.field !== 'string' ||
          (o.dir !== 'asc' && o.dir !== 'desc')
        ) {
          pushIssue(
            context,
            `${path}.orderBy[${i}]`,
            'invalid_order_by',
            'orderBy entries must be { field: string, dir: "asc" | "desc" }',
          );
        }
      });
    }
  }

  for (const key of ['take', 'skip'] as const) {
    if (key in rule && rule[key] !== undefined) {
      const v = rule[key];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        pushIssue(
          context,
          `${path}.${key}`,
          `invalid_window_${key}`,
          `${key} must be a non-negative integer`,
        );
      }
    }
  }
};

const pushIssue = (
  context: ValidationContext,
  path: string,
  code: string,
  message: string,
): void => {
  context.errors.push({ path, code, message });
};
