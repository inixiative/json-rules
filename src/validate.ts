import { isPlainObject as isPlainObjectLodash } from 'lodash-es';
import { unitAmountProblem } from './amount';
import { columnCompareProblem } from './columnCompare';
import { parseDateValue } from './date';
import {
  DEFAULT_ZONE,
  isDateExpr,
  isEdgeExpr,
  isPeriodExpr,
  namedPeriod,
  rollingShift,
} from './dateExpr';
import { resolveCaseInsensitive } from './engineGlobals';
import {
  ambiguousCondition,
  conditionRequired,
  countRequired,
  noCompiledForm,
  rangeExprRequired,
  unknownAggregateMode,
  unknownOperator,
  windowUnsupported,
} from './errors';
import { isJsonEntry, isRelationEntry } from './fieldMap/entry';
import { resolveFieldMap } from './fieldMap/resolveFieldMap';
import { comparesText } from './fieldMap/shape';
import type { FieldMap, FieldMapSet } from './fieldMap/types';
import { fieldEntry, relationTarget } from './fieldMap/walk';
import { isOrderedValue, readOrderedPair } from './number';
import type { ArrayOperator, DateOperator, Operator } from './operator';
import {
  AGGREGATE_MODES,
  AGGREGATE_OPERATORS,
  ARRAY_COUNT_OPERATORS,
  CONTAINS_OPERATORS,
  catalogEntry,
  DAY_NAMES,
  FieldKind,
  getValueShape,
  isDayName,
  isFieldKind,
  isOperatorSupportedForTarget,
  isRelativeUnit,
  OFFSET_OPERATORS,
  PERIOD_UNITS,
  RANGE_OPERATORS,
  type RuleTarget,
  SET_OPERATORS,
  type ValueShape,
  WINDOW_OPERATORS,
} from './operatorCatalog';
import { patternProblem } from './pattern';
import { parseScopeRef, scopeOutOfBounds } from './scope';
import { columnCompare, columnCompareError } from './toPrisma/columnRef';
import { groupPath } from './toPrisma/groupStep';
import { conditionShape } from './traverse';
import type { AggregateMode, ArrayRule, Condition, DateExpr, Rule, WindowFields } from './types';
import { rowRef, SOURCE_FORMS } from './valueSource';
import { hasWindow, windowRewrite } from './window';

export type ValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
};

/** Every validator's result: ok when it found nothing. */
export const validationResult = (errors: ValidationIssue[]): ValidationResult => ({
  ok: errors.length === 0,
  errors,
});

/** Every validator's assert form: throws the issues, one per line, under `label`. */
export const throwIfInvalid = (result: ValidationResult, label: string): void => {
  if (result.ok) return;
  throw new Error(`${label}:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
};

type ValidationContext = {
  target: RuleTarget;
  errors: ValidationIssue[];
  map?: FieldMap;
  /** The model each scope reads, outermost first (index = depth - 1), where the map knows it. */
  scopeModels: (string | undefined)[];
  /** Whether each scope sits inside a counting step (a count or relation aggregate condition). */
  stepScopes: boolean[];
};

/** Which engine a rule must compile for; `check` (the default) accepts every rule. The schema
 *  (`map` — a FieldMap, or a FieldMapSet with `mapName` — and `model`) lets the Prisma target
 *  accept a column compared with a column it can compile. */
export type ValidateRuleOptions = {
  target?: RuleTarget;
  map?: FieldMap | FieldMapSet;
  mapName?: string;
  model?: string;
};

/** A rule's shape checked without data: every node well formed, and runnable on `target`
 *  (operators, windows, scope refs, patterns). */
export const validateRule = (
  condition: unknown,
  options: ValidateRuleOptions = {},
): ValidationResult => {
  const context: ValidationContext = {
    target: options.target ?? 'check',
    errors: [],
    map: resolveFieldMap(options.map, options.mapName, 'toPrisma'),
    scopeModels: [options.model],
    stepScopes: [false],
  };

  validateCondition(condition, '$', context, 1);
  return validationResult(context.errors);
};

/** `validateRule`, throwing its issues; narrows the input to a `Condition`. */
export const assertValidRule = (
  condition: unknown,
  options: ValidateRuleOptions = {},
): asserts condition is Condition => {
  throwIfInvalid(validateRule(condition, options), 'validateRule');
};

const validateCondition = (
  condition: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (typeof condition === 'boolean') return;

  if (!isPlainObject(condition)) {
    pushIssue(context, path, 'invalid_condition', 'Condition must be a boolean or object');
    return;
  }

  const shape = conditionShape(condition);
  if (!shape) {
    pushIssue(context, path, 'ambiguous_condition', ambiguousCondition().message);
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
  columnCompare = false,
): void => {
  // A bare value path reads the root row: the scope `depth` levels out.
  const parsed = parseScopeRef(ref) ?? (key === 'path' ? { depth, path: ref } : null);
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
  // A field rule's comparison column is the Prisma rail's to judge (validateFieldRule).
  if (context.target === 'toPrisma' && !columnCompare) {
    pushIssue(
      context,
      issuePath,
      `unsupported_prisma_${key}`,
      key === 'path'
        ? `Path '${ref}' compares to a column, which isn't supported on the Prisma rail; use toSql() or check()`
        : `${label} '${ref}' is not supported by toPrisma()`,
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

// A relation node's condition / filter reads the relation's model one scope in.
const enterScope = (
  context: ValidationContext,
  depth: number,
  field: unknown,
  step = false,
): void => {
  context.stepScopes[depth] = step || context.stepScopes[depth - 1] === true;
  const outer = context.scopeModels[depth - 1];
  context.scopeModels[depth] =
    context.map && outer && typeof field === 'string'
      ? (relationTarget(field, context.map, outer) ?? undefined)
      : undefined;
};

// One value source — `{ value } | { path } | { bind }` — wherever it appears: a rule's comparison
// value, an offset, a unit amount. Exactly one form; `bindOptional` only beside `bind`; a path is
// gated like any ref. Returns the form, or null when it is malformed.
const validateSource = (
  source: Record<string, unknown>,
  at: string,
  context: ValidationContext,
  depth: number,
  columnCompare = false,
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
  if (form === 'path')
    validateRef(source.path as string, 'path', `${at}.path`, context, depth, columnCompare);
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
  const rolling =
    isPlainObject(value) && Object.keys(value).length === 1 && isDateExpr(value)
      ? rollingShift(value)
      : null;
  if (!rolling) {
    pushIssue(
      context,
      `${at}.value`,
      'invalid_offset',
      'A date offset value is { ago } or { ahead }',
    );
    return;
  }
  validateRelativeUnits(
    rolling[0],
    `${at}.value.${Object.keys(value as object)[0]}`,
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

  if (typeof rule.operator !== 'string' || !catalogEntry(rule.operator, 'field')) {
    pushIssue(
      context,
      `${path}.operator`,
      'invalid_operator',
      unknownOperator(rule.operator, 'field').message,
    );
    return;
  }

  const operator = rule.operator as Operator;
  validateOffset(rule, 'field', operator, path, context, depth);

  if (!isOperatorSupportedForTarget(operator, 'field', context.target)) {
    pushIssue(
      context,
      `${path}.operator`,
      `unsupported_${targetSlug(context.target)}_operator`,
      `Operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  if (rule.coerceType !== undefined && !isFieldKind(rule.coerceType)) {
    pushIssue(
      context,
      `${path}.coerceType`,
      'invalid_coerce_type',
      `coerceType must be one of: ${Object.keys(FieldKind).join(', ')}`,
    );
  }

  const shape = getValueShape(operator, 'field');

  if (shape === 'none') {
    forbidValueAndPath(rule, path, context);
    return;
  }

  if (validateSource(rule, path, context, depth, true) === null) return;
  rejectSqlRowRange(rule, operator, path, context);
  if (context.target === 'toPrisma' && typeof rule.path === 'string') {
    const compare = columnCompare(
      rule as unknown as Rule,
      context.map,
      context.scopeModels[depth - 1],
      depth > 1,
      context.stepScopes[depth - 1] === true,
    );
    if ('problem' in compare)
      pushIssue(
        context,
        `${path}.path`,
        'unsupported_prisma_path',
        columnCompareError(rule.path, compare.problem).message,
      );
  }
  if (context.target === 'toSql' && typeof rule.path === 'string' && context.map) {
    const model = context.scopeModels[depth - 1];
    const column = (parseScopeRef(rule.path) ?? { path: rule.path }).path;
    const problem = columnCompareProblem(
      fieldEntry(rule.field as string, context.map, model),
      fieldEntry(column, context.map, model),
      operator,
    );
    if (problem)
      pushIssue(context, `${path}.path`, 'unsupported_sql_path', `'${rule.path}': ${problem}`);
  }
  // A substring, pattern or set is bound when toSql compiles; against a column there is no SQL
  // form — save a list holding a column's value (membership).
  if (
    context.target === 'toSql' &&
    typeof rule.path === 'string' &&
    ['array', 'pattern', 'string'].includes(shape)
  ) {
    const field = context.map
      ? fieldEntry(rule.field as string, context.map, context.scopeModels[depth - 1])
      : undefined;
    if (!(field?.isList && CONTAINS_OPERATORS.includes(operator)))
      pushIssue(
        context,
        `${path}.path`,
        'unsupported_sql_path',
        `'${operator}' against the column '${rule.path}' has no SQL form`,
      );
  }
  if (typeof rule.path === 'string' || typeof rule.bind === 'string') return;
  validatePrismaLiteral(rule, operator, path, context, depth);

  validateValueShape(shape, rule.value, operator, `${path}.value`, context);
};

// What toPrisma reads off a literal against the column it names, as its compile does: a list
// column's filters take no null element and no case-insensitive mode (a set of members excepted,
// which compiles to membership), and a case-insensitive comparison against Json has no exact form.
const validatePrismaLiteral = (
  rule: Record<string, unknown>,
  operator: Operator,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  if (context.target !== 'toPrisma' || !context.map || typeof rule.field !== 'string') return;
  const entry = fieldEntry(rule.field, context.map, context.scopeModels[depth - 1]);
  if (!entry) return;
  const value = rule.value;
  const insensitive = resolveCaseInsensitive(rule.caseInsensitive as boolean | undefined);
  const members = SET_OPERATORS.includes(operator) && Array.isArray(value);
  const refuse = (what: string) =>
    pushIssue(
      context,
      `${path}.value`,
      'unsupported_prisma_operator',
      noCompiledForm('toPrisma', what).message,
    );
  if (entry.isList && !members && Array.isArray(value) && value.includes(null))
    refuse(`A list holding null in '${rule.field}'`);
  else if (entry.isList && !members && insensitive && comparesText('text', value))
    refuse(`A case-insensitive comparison on the list '${rule.field}'`);
  else if (isJsonEntry(entry) && insensitive)
    refuse(`A case-insensitive comparison on the Json column '${rule.field}'`);
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
      if (!isOrderedValue(value)) {
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
    case 'pattern': {
      if (!(typeof value === 'string' || value instanceof RegExp)) {
        pushIssue(
          context,
          path,
          'invalid_pattern_value',
          `Operator '${operator}' requires a string or RegExp value`,
        );
        return;
      }
      const problem = patternProblem(value, context.target);
      if (problem) pushIssue(context, path, 'unsupported_pattern', problem);
      return;
    }
    case 'range':
      try {
        readOrderedPair(value, operator);
      } catch (error) {
        pushIssue(context, path, 'invalid_range_value', (error as Error).message);
      }
      return;
  }
};

// A count or a relation aggregate compiles to a Prisma group step over the relation it names; the
// compiler's own path check says whether that relation can carry one (a list relation with its
// keys declared — not a Json list, nor an implicit many-to-many).
const validateGroupStep = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
  kind: 'Count operators' | 'Aggregate rules',
): void => {
  const model = context.scopeModels[depth - 1];
  if (context.target !== 'toPrisma' || !context.map || !model || typeof rule.field !== 'string')
    return;
  try {
    groupPath(rule.field, context.map, model, kind);
  } catch (error) {
    pushIssue(context, `${path}.field`, 'unsupported_prisma_relation', (error as Error).message);
  }
};

const validateAggregateRule = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  validateGroupStep(rule, path, context, depth, 'Aggregate rules');
  if (rule.offset !== undefined)
    pushIssue(context, `${path}.offset`, 'unexpected_offset', 'Aggregate rules take no offset');
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
  if (!AGGREGATE_MODES.includes(agg.mode as AggregateMode))
    pushIssue(
      context,
      `${path}.aggregate.mode`,
      'invalid_aggregate_mode',
      unknownAggregateMode(agg.mode).message,
    );

  if ('field' in agg && agg.field !== undefined && typeof agg.field !== 'string') {
    pushIssue(
      context,
      `${path}.aggregate.field`,
      'invalid_aggregate_field',
      'aggregate.field must be a string',
    );
  }

  if (!AGGREGATE_OPERATORS.includes(rule.operator as Operator)) {
    pushIssue(
      context,
      `${path}.operator`,
      'invalid_aggregate_operator',
      `Aggregate rules only support: ${AGGREGATE_OPERATORS.join(', ')}`,
    );
    return;
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
    enterScope(context, depth, rule.field, true);
    validateCondition(rule.condition, `${path}.condition`, context, depth + 1);
  }

  if (validateSource(rule, path, context, depth) === null) return;
  if (typeof rule.path === 'string' || typeof rule.bind === 'string') return;

  const value = rule.value;
  if (RANGE_OPERATORS.includes(rule.operator as string)) {
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

  if (typeof rule.arrayOperator !== 'string' || !catalogEntry(rule.arrayOperator, 'array')) {
    pushIssue(
      context,
      `${path}.arrayOperator`,
      'invalid_array_operator',
      unknownOperator(rule.arrayOperator, 'array').message,
    );
    return;
  }

  const operator = rule.arrayOperator as ArrayOperator;
  if (ARRAY_COUNT_OPERATORS.includes(operator))
    validateGroupStep(rule, path, context, depth, 'Count operators');
  // An array a column holds (a scalar list, a Json array) has no Prisma filter over its elements:
  // only its emptiness compiles.
  const held =
    context.target === 'toPrisma' && context.map && typeof rule.field === 'string'
      ? fieldEntry(rule.field, context.map, context.scopeModels[depth - 1])
      : undefined;
  if (held && !isRelationEntry(held) && operator !== 'empty' && operator !== 'notEmpty')
    pushIssue(
      context,
      `${path}.arrayOperator`,
      'unsupported_prisma_array_operator',
      noCompiledForm('toPrisma', `'${operator}' over the array column '${rule.field}'`).message,
    );

  if (!isOperatorSupportedForTarget(operator, 'array', context.target)) {
    pushIssue(
      context,
      `${path}.arrayOperator`,
      `unsupported_${targetSlug(context.target)}_array_operator`,
      `Array operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  // What the operator reads, as the catalog says: nothing, a predicate per element, or a count of
  // the elements that match.
  const shape = getValueShape(operator as ArrayOperator, 'array');
  const hasCondition = rule.condition !== undefined;
  const refuseCount = (): void => {
    if (rule.count !== undefined)
      pushIssue(
        context,
        `${path}.count`,
        'unexpected_count',
        `Array operator '${operator}' does not accept count`,
      );
  };
  if (shape === 'none') {
    if (hasCondition)
      pushIssue(
        context,
        `${path}.condition`,
        'unexpected_condition',
        `Array operator '${operator}' does not accept condition`,
      );
    refuseCount();
  } else if (shape === 'predicate') {
    if (hasCondition) {
      enterScope(context, depth, rule.field);
      validateCondition(rule.condition, `${path}.condition`, context, depth + 1);
    } else
      pushIssue(
        context,
        `${path}.condition`,
        'missing_condition',
        conditionRequired(operator).message,
      );
    refuseCount();
  } else if (shape === 'count') {
    if (context.target !== 'toPrisma' && typeof rule.count !== 'number')
      pushIssue(context, `${path}.count`, 'missing_count', countRequired(operator).message);
    else if (
      rule.count !== undefined &&
      !(typeof rule.count === 'number' && Number.isInteger(rule.count) && rule.count >= 0)
    )
      pushIssue(
        context,
        `${path}.count`,
        'invalid_count',
        'count must be a non-negative whole number',
      );
    if (hasCondition) {
      enterScope(context, depth, rule.field, true);
      validateCondition(rule.condition, `${path}.condition`, context, depth + 1);
    } else if (context.target === 'check')
      pushIssue(
        context,
        `${path}.condition`,
        'missing_condition',
        conditionRequired(operator).message,
      );
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

  if (typeof rule.dateOperator !== 'string' || !catalogEntry(rule.dateOperator, 'date')) {
    pushIssue(
      context,
      `${path}.dateOperator`,
      'invalid_date_operator',
      unknownOperator(rule.dateOperator, 'date').message,
    );
    return;
  }

  const operator = rule.dateOperator as DateOperator;
  validateOffset(rule, 'date', operator, path, context, depth);

  if (!isOperatorSupportedForTarget(operator, 'date', context.target)) {
    pushIssue(
      context,
      `${path}.dateOperator`,
      `unsupported_${targetSlug(context.target)}_date_operator`,
      `Date operator '${operator}' is not supported by ${context.target}()`,
    );
  }

  const shape = getValueShape(operator, 'date');

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

  // Structured date expressions: ago/ahead, this/last/next, start/end.
  if (isDateExpr(rule.value)) {
    validateDateExpr(rule.value, operator, `${path}.value`, context, depth);
    return;
  }

  if (WINDOW_OPERATORS.includes(operator)) {
    // The range operators only accept an expression range (period or rolling), not a literal pair.
    pushIssue(context, `${path}.value`, 'invalid_date_range', rangeExprRequired(operator).message);
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
      } else if (isOrderedValue(item) && !parseDateValue(item, DEFAULT_ZONE).isValid()) {
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

  if (!isOrderedValue(rule.value)) {
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

// --- Date-expression validation ---
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
    const problem = unitAmountProblem(amount, key);
    if (problem) pushIssue(context, `${path}.${key}`, 'invalid_relative_magnitude', problem);
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

  const rolling = rollingShift(expr);
  if (rolling) {
    validateRelativeUnits(rolling[0], path, context, depth);
    return;
  }

  if (isPeriodExpr(expr)) {
    validatePeriodUnit(namedPeriod(expr), path, context);
    return;
  }

  if (isEdgeExpr(expr)) {
    if (isRange) {
      pushIssue(context, path, 'invalid_date_range', rangeExprRequired(operator).message);
      return;
    }
    const period = 'start' in expr ? expr.start : expr.end;
    if (!isPlainObject(period) || !isPeriodExpr(period)) {
      pushIssue(context, path, 'invalid_period_unit', `start/end requires a this/last/next period`);
      return;
    }
    validatePeriodUnit(namedPeriod(period), path, context);
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

const isNumericRange = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number';

const isDateRangeOrExprPair = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 2 &&
  (isOrderedValue(value[0]) || isDateExpr(value[0])) &&
  (isOrderedValue(value[1]) || isDateExpr(value[1]));

const validateWindow = (
  rule: Record<string, unknown>,
  path: string,
  context: ValidationContext,
  depth: number,
): void => {
  const windowed = hasWindow(rule as WindowFields);

  if (windowed && context.target !== 'check') {
    // toPrisma compiles a filter-only window and the extremal (take:1, aligned) one.
    const eligible =
      context.target === 'toPrisma' && windowRewrite(rule as unknown as ArrayRule) !== null;
    if (!eligible) {
      pushIssue(
        context,
        path,
        `unsupported_${targetSlug(context.target)}_window`,
        windowUnsupported(context.target).message,
      );
    }
  }

  if ('filter' in rule && rule.filter !== undefined) {
    enterScope(context, depth, rule.field);
    validateCondition(rule.filter, `${path}.filter`, context, depth + 1);
  }

  if ('orderBy' in rule && rule.orderBy !== undefined) {
    const ob = rule.orderBy;
    // An empty orderBy orders nothing: no window, as hasWindow reads it.
    if (!Array.isArray(ob)) {
      pushIssue(
        context,
        `${path}.orderBy`,
        'invalid_order_by',
        'orderBy must be an array of { field, dir }',
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
