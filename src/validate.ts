import { ArrayOperator, DateOperator, Operator } from './operator';
import type { Condition, DateInputValue, OrderedRuleValue } from './types';

export type RuleValidationTarget = 'check' | 'toPrisma' | 'toSql';

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
  target: RuleValidationTarget;
  errors: ValidationIssue[];
};

const FIELD_OPERATORS = new Set<string>(Object.values(Operator));
const ARRAY_OPERATORS = new Set<string>(Object.values(ArrayOperator));
const DATE_OPERATORS = new Set<string>(Object.values(DateOperator));

export const validateRule = (
  condition: unknown,
  options: { target?: RuleValidationTarget } = {},
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
  options: { target?: RuleValidationTarget } = {},
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

  if (context.target === 'toPrisma') {
    if ((operator === Operator.matches || operator === Operator.notMatches) && 'operator' in rule) {
      pushIssue(
        context,
        `${path}.operator`,
        'unsupported_prisma_operator',
        `Operator '${operator}' is not supported by toPrisma()`,
      );
    }
    if (typeof rule.path === 'string' && rule.path.startsWith('$.')) {
      pushIssue(
        context,
        `${path}.path`,
        'unsupported_prisma_path',
        `Path '${rule.path}' is not supported by toPrisma()`,
      );
    }
  }

  if (isPresenceOperator(operator)) {
    forbidValueAndPath(rule, path, context);
    return;
  }

  if (!requireValueOrPath(rule, path, context)) return;

  if ('path' in rule && typeof rule.path === 'string') return;

  const value = rule.value;
  switch (operator) {
    case Operator.lessThan:
    case Operator.lessThanEquals:
    case Operator.greaterThan:
    case Operator.greaterThanEquals:
      if (!isOrderedRuleValue(value)) {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_ordered_value',
          `Operator '${operator}' requires a string, number, or Date value`,
        );
      }
      break;
    case Operator.in:
    case Operator.notIn:
      if (!Array.isArray(value)) {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_membership_value',
          `Operator '${operator}' requires an array value`,
        );
      }
      break;
    case Operator.matches:
    case Operator.notMatches:
      if (!(typeof value === 'string' || value instanceof RegExp)) {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_pattern_value',
          `Operator '${operator}' requires a string or RegExp value`,
        );
      }
      break;
    case Operator.startsWith:
    case Operator.endsWith:
      if (typeof value !== 'string') {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_string_value',
          `Operator '${operator}' requires a string value`,
        );
      }
      break;
    case Operator.between:
    case Operator.notBetween:
      if (!isOrderedRange(value)) {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_range_value',
          `Operator '${operator}' requires a two-item range`,
        );
      }
      break;
  }
};

const AGGREGATE_SINGLE_OPERATORS = new Set<string>([
  Operator.equals,
  Operator.notEquals,
  Operator.lessThan,
  Operator.lessThanEquals,
  Operator.greaterThan,
  Operator.greaterThanEquals,
]);

const AGGREGATE_RANGE_OPERATORS = new Set<string>([Operator.between, Operator.notBetween]);

const validateAggregateRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void => {
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
    typeof rule.operator === 'string' && AGGREGATE_SINGLE_OPERATORS.has(rule.operator);
  const isRange = typeof rule.operator === 'string' && AGGREGATE_RANGE_OPERATORS.has(rule.operator);

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
    pushIssue(context, `${path}.field`, 'field_required', 'Array rule requires a string field');
  }

  if (typeof rule.arrayOperator !== 'string' || !ARRAY_OPERATORS.has(rule.arrayOperator)) {
    pushIssue(context, `${path}.arrayOperator`, 'invalid_array_operator', 'Unknown array operator');
    return;
  }

  const operator = rule.arrayOperator as ArrayOperator;

  if (context.target === 'toSql' && isComplexArrayOperator(operator)) {
    pushIssue(
      context,
      `${path}.arrayOperator`,
      'unsupported_sql_array_operator',
      `Array operator '${operator}' is not supported by toSql()`,
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

  if (context.target === 'toPrisma') {
    if (
      (operator === DateOperator.dayIn || operator === DateOperator.dayNotIn) &&
      'dateOperator' in rule
    ) {
      pushIssue(
        context,
        `${path}.dateOperator`,
        'unsupported_prisma_date_operator',
        `Date operator '${operator}' is not supported by toPrisma()`,
      );
    }
    if (typeof rule.path === 'string' && rule.path.startsWith('$.')) {
      pushIssue(
        context,
        `${path}.path`,
        'unsupported_prisma_path',
        `Path '${rule.path}' is not supported by toPrisma()`,
      );
    }
  }

  switch (operator) {
    case DateOperator.dayIn:
    case DateOperator.dayNotIn:
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
    case DateOperator.between:
    case DateOperator.notBetween:
      if (!requireValueOrPath(rule, path, context)) return;
      if ('path' in rule && typeof rule.path === 'string') return;
      if (!isDateRange(rule.value)) {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_date_range',
          `Date operator '${operator}' requires a two-item date range`,
        );
      }
      return;
    default:
      if (!requireValueOrPath(rule, path, context)) return;
      if ('path' in rule && typeof rule.path === 'string') return;
      if (!isDateInputValue(rule.value)) {
        pushIssue(
          context,
          `${path}.value`,
          'invalid_date_value',
          `Date operator '${operator}' requires a date-like value`,
        );
      }
  }
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

const isPresenceOperator = (operator: Operator): boolean =>
  operator === Operator.isEmpty ||
  operator === Operator.notEmpty ||
  operator === Operator.exists ||
  operator === Operator.notExists;

const isComplexArrayOperator = (operator: ArrayOperator): boolean =>
  operator === ArrayOperator.all ||
  operator === ArrayOperator.any ||
  operator === ArrayOperator.none ||
  operator === ArrayOperator.atLeast ||
  operator === ArrayOperator.atMost ||
  operator === ArrayOperator.exactly;

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

const isDateRange = (value: unknown): value is [DateInputValue, DateInputValue] =>
  Array.isArray(value) &&
  value.length === 2 &&
  isDateInputValue(value[0]) &&
  isDateInputValue(value[1]);

const pushIssue = (
  context: ValidationContext,
  path: string,
  code: string,
  message: string,
): void => {
  context.errors.push({ path, code, message });
};
