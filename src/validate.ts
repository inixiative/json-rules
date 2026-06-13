import { isDateExpr, isEdgeExpr, isPeriodExpr, isRollingExpr } from './dateExpr';
import { ArrayOperator, type DateOperator, Operator } from './operator';
import {
  ARRAY_OPERATOR_CATALOG,
  DATE_OPERATOR_CATALOG,
  FIELD_OPERATOR_CATALOG,
  getValueShape,
  isAggregateRangeOperator,
  isAggregateSingleOperator,
  isOperatorSupportedForTarget,
  type RuleTarget,
  type ValueShape,
} from './operatorCatalog';
import type { ArrayRule, Condition, DateExpr, DateInputValue, OrderedRuleValue } from './types';
import { extremalRewrite } from './window';

const PERIOD_UNITS = new Set([
  'year',
  'quarter',
  'month',
  'week',
  'isoWeek',
  'day',
  'hour',
  'minute',
  'second',
]);
const RELATIVE_UNIT_KEYS = new Set([
  'years',
  'quarters',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
  'seconds',
]);

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

  validateCondition(condition, '$', context);
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

const validateCondition = (condition: unknown, path: string, context: ValidationContext): void => {
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
      validateLogicalArray(condition.all, `${path}.all`, context);
      break;
    case 'any':
      validateLogicalArray(condition.any, `${path}.any`, context);
      break;
    case 'if':
      validateCondition(condition.if, `${path}.if`, context);
      validateCondition(condition.then, `${path}.then`, context);
      if ('else' in condition && condition.else !== undefined) {
        validateCondition(condition.else, `${path}.else`, context);
      }
      break;
    case 'field':
      validateFieldRule(condition, path, context);
      break;
    case 'aggregate':
      validateAggregateRule(condition, path, context);
      break;
    case 'array':
      validateArrayRule(condition, path, context);
      break;
    case 'date':
      validateDateRule(condition, path, context);
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

const validateLogicalArray = (value: unknown, path: string, context: ValidationContext): void => {
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
    validateCondition(item, `${path}[${index}]`, context);
  });
};

const validateFieldRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void => {
  if (typeof rule.field !== 'string') {
    pushIssue(context, `${path}.field`, 'field_required', 'Field rule requires a string field');
  }

  if (typeof rule.operator !== 'string' || !FIELD_OPERATORS.has(rule.operator)) {
    pushIssue(context, `${path}.operator`, 'invalid_operator', 'Unknown field operator');
    return;
  }

  const operator = rule.operator as Operator;

  if (!isOperatorSupportedForTarget(operator, context.target)) {
    pushIssue(
      context,
      `${path}.operator`,
      `unsupported_${targetSlug(context.target)}_operator`,
      `Operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  if (
    context.target === 'toPrisma' &&
    typeof rule.path === 'string' &&
    rule.path.startsWith('$.')
  ) {
    pushIssue(
      context,
      `${path}.path`,
      'unsupported_prisma_path',
      `Path '${rule.path}' is not supported by toPrisma()`,
    );
  }

  const shape = getValueShape(operator);

  if (shape === 'none') {
    forbidValueAndPath(rule, path, context);
    return;
  }

  if (!requireValueOrPath(rule, path, context)) return;
  if ('path' in rule && typeof rule.path === 'string') return;

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
): void => {
  validateWindow(rule, path, context);

  if (typeof rule.field !== 'string') {
    pushIssue(context, `${path}.field`, 'field_required', 'Aggregate rule requires a string field');
  }

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

  if (context.target === 'toPrisma' && rule.operator === Operator.notBetween) {
    pushIssue(
      context,
      `${path}.operator`,
      'unsupported_prisma_aggregate_operator',
      `Operator 'notBetween' is not supported by toPrisma() for aggregate rules`,
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
    validateCondition(rule.condition, `${path}.condition`, context);
  }

  if (!requireValueOrPath(rule, path, context)) return;
  if ('path' in rule && typeof rule.path === 'string') return;

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

  validateWindow(rule, path, context);

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
        validateCondition(rule.condition, `${path}.condition`, context);
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
        validateCondition(rule.condition, `${path}.condition`, context);
      }
      break;
  }
};

const validateDateRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void => {
  if (typeof rule.field !== 'string') {
    pushIssue(context, `${path}.field`, 'field_required', 'Date rule requires a string field');
  }

  if (typeof rule.dateOperator !== 'string' || !DATE_OPERATORS.has(rule.dateOperator)) {
    pushIssue(context, `${path}.dateOperator`, 'invalid_date_operator', 'Unknown date operator');
    return;
  }

  const operator = rule.dateOperator as DateOperator;

  if (!isOperatorSupportedForTarget(operator, context.target)) {
    pushIssue(
      context,
      `${path}.dateOperator`,
      `unsupported_${targetSlug(context.target)}_date_operator`,
      `Date operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  if (
    context.target === 'toPrisma' &&
    typeof rule.path === 'string' &&
    rule.path.startsWith('$.')
  ) {
    pushIssue(
      context,
      `${path}.path`,
      'unsupported_prisma_path',
      `Path '${rule.path}' is not supported by toPrisma()`,
    );
  }

  const shape = getValueShape(operator);

  if (shape === 'dayList') {
    if (!Array.isArray(rule.value) || !rule.value.every((item) => typeof item === 'string')) {
      pushIssue(
        context,
        `${path}.value`,
        'invalid_day_list',
        `Date operator '${operator}' requires an array of day names`,
      );
    }
    if ('path' in rule && rule.path !== undefined) {
      pushIssue(
        context,
        `${path}.path`,
        'unexpected_path',
        `Date operator '${operator}' does not accept path`,
      );
    }
    return;
  }

  if (!requireValueOrPath(rule, path, context)) return;
  if ('path' in rule && typeof rule.path === 'string') return;

  // Structured date expressions (v2.6): ago/ahead, this/last/next, start/end.
  if (isDateExpr(rule.value)) {
    validateDateExpr(rule.value, operator, `${path}.value`, context);
    return;
  }

  if (operator === 'within') {
    // `within` only accepts an expression range (period or rolling), not a literal pair.
    pushIssue(
      context,
      `${path}.value`,
      'invalid_date_range',
      `Date operator 'within' requires a range date expression (a period or rolling window)`,
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
      if (isDateExpr(item)) validateDateExpr(item, operator, `${path}.value[${i}]`, context);
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
  }
};

// --- v2.6 date-expression validation ---
const validateRelativeUnits = (units: unknown, path: string, context: ValidationContext): void => {
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
    if (!RELATIVE_UNIT_KEYS.has(key)) {
      pushIssue(
        context,
        `${path}.${key}`,
        'invalid_relative_unit',
        `Unknown relative unit '${key}'`,
      );
      continue;
    }
    if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 0) {
      pushIssue(
        context,
        `${path}.${key}`,
        'invalid_relative_magnitude',
        `Relative magnitudes must be positive numbers (got ${String(magnitude)})`,
      );
    }
  }
};

const validatePeriodUnit = (unit: unknown, path: string, context: ValidationContext): void => {
  if (typeof unit !== 'string' || !PERIOD_UNITS.has(unit)) {
    pushIssue(context, path, 'invalid_period_unit', `Unknown period unit '${String(unit)}'`);
  }
};

const validateDateExpr = (
  expr: DateExpr,
  operator: DateOperator,
  path: string,
  context: ValidationContext,
): void => {
  const isRange = operator === 'within';

  if (isRollingExpr(expr)) {
    validateRelativeUnits('ago' in expr ? expr.ago : expr.ahead, path, context);
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
        `'within' requires a range (period or rolling); a start/end edge is a single point`,
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

const requireValueOrPath = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): boolean => {
  const hasValue = 'value' in rule && rule.value !== undefined;
  const hasPath = typeof rule.path === 'string';

  if (hasValue && hasPath) {
    pushIssue(context, path, 'ambiguous_value_source', 'Rule cannot define both value and path');
    return false;
  }

  if (!hasValue && !hasPath) {
    pushIssue(context, path, 'missing_value_source', 'Rule requires either value or path');
    return false;
  }

  return true;
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
};

const targetSlug = (target: RuleTarget): string =>
  target === 'toPrisma' ? 'prisma' : target === 'toSql' ? 'sql' : 'check';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const isDateInputValue = (value: unknown): value is DateInputValue =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;

const isDateRangeOrExprPair = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 2 &&
  (isDateInputValue(value[0]) || isDateExpr(value[0])) &&
  (isDateInputValue(value[1]) || isDateExpr(value[1]));

const validateWindow = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
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
    validateCondition(rule.filter, `${path}.filter`, context);
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
