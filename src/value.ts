import { isPlainObject } from 'lodash-es';
import {
  aggregateItems,
  aggregateValues,
  type CheckOptions,
  type EvalOptions,
  holdsIn,
  sumOrAverage,
} from './check';
import { clockUnit } from './clock';
import {
  invalidValueExpression,
  UsageError,
  unknownValueAggregateMode,
  valueTakesNoComparison,
} from './errors';
import { isRelationEntry } from './fieldMap/entry';
import { entryKind } from './fieldMap/shape';
import type { FieldMapEntry } from './fieldMap/types';
import { readPaths } from './lens/readPaths';
import type { Lens, LensNarrowing } from './lens/types';
import { validateRuleInLens } from './lens/validateRuleInLens';
import { walkLensPath } from './lens/walkLensPath';
import {
  AGGREGATE_MODE_CATALOG,
  type ClockUnit,
  FieldKind,
  isValueAggregateMode,
  NUMERIC_KINDS,
  ORDERED_VALUE_KINDS,
} from './operatorCatalog';
import { parseScopeRef } from './scope';
import { valueExpressionShape, valueReads } from './traverse';
import type {
  AggregateValue,
  Condition,
  IfThenElseValue,
  Row,
  ValueAggregateMode,
  ValueExpression,
  ValueType,
} from './types';
import {
  throwIfInvalid,
  type ValidationIssue,
  type ValidationResult,
  validateRule,
  validationResult,
} from './validate';
import { readValueSource } from './valueSource';

type Node = Record<string, unknown>;

const SOURCE_KEYS = ['value', 'path', 'bind', 'bindOptional'];
const IF_KEYS = ['if', 'then', 'else'];
const AGGREGATE_KEYS = ['field', 'aggregate', 'condition', 'filter', 'orderBy', 'take', 'skip'];
const SHAPE_KEYS = { source: SOURCE_KEYS, if: IF_KEYS, aggregate: AGGREGATE_KEYS } as const;

// An aggregate value written as an aggregate rule: it names a comparison.
const namesComparison = (node: Node): boolean =>
  isPlainObject(node) &&
  'aggregate' in node &&
  ['operator', 'value', 'path', 'bind'].some((key) => key in node);

// ─── evaluate ────────────────────────────────────────────────────────────────

/**
 * The value an expression computes from a row, in memory, with what check() takes (`bindings`,
 * `now`, `timeZone`, `weekStart`, `absent`): a literal, a path read (null when absent), a bound
 * value, an aggregate over a relation's rows (`count`, `sum`, `avg`, `min`, `max`, through its
 * window and condition), the branch an `if` picks, or a list. Throws on a malformed expression,
 * as check() throws on a malformed rule; `validateValue` reports every problem without data.
 */
export const evaluateValue = (
  expression: ValueExpression,
  data: Row,
  options: CheckOptions = {},
): unknown => evaluateAt(expression, { ...options, scopes: [data] }, '$');

const evaluateAt = (expr: unknown, opts: EvalOptions, path: string): unknown => {
  const node = expr as Node;
  switch (valueExpressionShape(expr)) {
    case 'source':
      return readValueSource(node, opts.scopes, opts.bindings);
    case 'aggregate':
      return aggregateValue(node as AggregateValue, opts, path);
    case 'if': {
      const branch = pickBranch(node as IfThenElseValue, opts, path);
      return branch === undefined ? null : evaluateAt(branch.expr, opts, branch.path);
    }
    case 'list':
      return (expr as unknown[]).flatMap((item, index) => {
        const at = `${path}[${index}]`;
        if (valueExpressionShape(item) === 'list')
          throw new Error(`${at}: a list's items are single values`);
        if (valueExpressionShape(item) !== 'if') return [evaluateAt(item, opts, at)];
        // An item an `if` with no `else` turns down adds nothing.
        const branch = pickBranch(item as IfThenElseValue, opts, at);
        return branch === undefined ? [] : [evaluateAt(branch.expr, opts, branch.path)];
      });
    default:
      throw namesComparison(node) ? valueTakesNoComparison(path) : invalidValueExpression(path);
  }
};

const pickBranch = (
  node: IfThenElseValue,
  opts: EvalOptions,
  path: string,
): { expr: unknown; path: string } | undefined => {
  if (node.if === undefined || node.then === undefined)
    throw new Error(`${path}: if / then takes both an if and a then`);
  if (holdsIn(node.if, opts)) return { expr: node.then, path: `${path}.then` };
  return node.else === undefined ? undefined : { expr: node.else, path: `${path}.else` };
};

type Ordered = number | bigint | string | Date;

const orderedValue = (raw: unknown, loc: string): Ordered => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint' || typeof raw === 'string') return raw;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  throw new Error(`${loc} must be a finite number, a string or a valid date for min / max`);
};

const orderClass = (value: Ordered): string =>
  value instanceof Date ? 'date' : typeof value === 'bigint' ? 'number' : typeof value;

// The least or greatest of one kind of value; null over none.
const extreme = (values: Ordered[], mode: 'min' | 'max', field: string): Ordered | null => {
  if (values.length === 0) return null;
  const kinds = new Set(values.map(orderClass));
  if (kinds.size > 1)
    throw new Error(`${field} ${mode} orders one kind of value, not ${[...kinds].join(' and ')}`);
  const key = (value: Ordered) => (value instanceof Date ? value.getTime() : value);
  return values.reduce((best, value) =>
    (mode === 'max' ? key(value) > key(best) : key(value) < key(best)) ? value : best,
  );
};

const aggregateValue = (node: AggregateValue, opts: EvalOptions, path: string): unknown => {
  if (namesComparison(node as Node)) throw valueTakesNoComparison(path);
  if (!isPlainObject(node.aggregate)) throw new Error(`${path}.aggregate must be an object`);
  const { mode, field: itemField } = node.aggregate;
  if (!isValueAggregateMode(mode)) throw unknownValueAggregateMode(mode);
  if (typeof node.field !== 'string' || node.field === '')
    throw new Error(`${path}.field: an aggregate value reads a list field`);
  const items = aggregateItems(node, opts);
  switch (mode) {
    case 'count':
      // COUNT(*) over the items, or COUNT(field) — the items whose field has a value.
      return itemField === undefined
        ? items.length
        : aggregateValues(items, node.field, itemField, () => true).length;
    case 'sum':
    case 'avg':
      return sumOrAverage(mode, items, node.field, itemField);
    default:
      return extreme(aggregateValues(items, node.field, itemField, orderedValue), mode, node.field);
  }
};

// ─── validate ────────────────────────────────────────────────────────────────

const prefixed = (issues: ValidationIssue[], path: string): ValidationIssue[] =>
  issues.map((issue) => ({
    ...issue,
    path: issue.path.startsWith('$') ? `${path}${issue.path.slice(1)}` : `${path}.${issue.path}`,
  }));

const validateAt = (expr: unknown, path: string, inList: boolean): ValidationIssue[] => {
  const node = expr as Node;
  const shape = valueExpressionShape(expr);
  if (shape === null) {
    const error = namesComparison(node)
      ? valueTakesNoComparison(path)
      : invalidValueExpression(path);
    const code = namesComparison(node) ? 'unexpected_comparison' : 'invalid_value_expression';
    return [{ path, code, message: error.message.slice(path.length + 2) }];
  }
  if (shape === 'list') {
    if (inList) return [{ path, code: 'nested_list', message: "a list's items are single values" }];
    return (expr as unknown[]).flatMap((item, index) =>
      validateAt(item, `${path}[${index}]`, true),
    );
  }
  const unknownKeys = Object.keys(node)
    .filter((key) => !(SHAPE_KEYS[shape] as readonly string[]).includes(key))
    .map((key) => ({
      path: `${path}.${key}`,
      code: 'unknown_key',
      message: `a ${shape === 'source' ? 'value source' : `${shape} value`} takes ${SHAPE_KEYS[shape].join(', ')}, not '${key}'`,
    }));
  if (shape === 'if') {
    const issues = [...unknownKeys];
    if (node.if === undefined)
      issues.push({
        path: `${path}.if`,
        code: 'condition_required',
        message: 'if / then takes an if',
      });
    else issues.push(...prefixed(validateRule(node.if).errors, `${path}.if`));
    if (node.then === undefined)
      issues.push({
        path: `${path}.then`,
        code: 'value_required',
        message: 'if / then takes a then',
      });
    else issues.push(...validateAt(node.then, `${path}.then`, inList));
    if (node.else !== undefined) issues.push(...validateAt(node.else, `${path}.else`, inList));
    return issues;
  }
  if (shape === 'aggregate') {
    const issues = [...unknownKeys];
    const agg = node.aggregate;
    if (!isPlainObject(agg))
      return [
        ...issues,
        {
          path: `${path}.aggregate`,
          code: 'invalid_aggregate',
          message: 'aggregate must be an object',
        },
      ];
    const { mode } = agg as { mode?: unknown };
    if (!isValueAggregateMode(mode))
      issues.push({
        path: `${path}.aggregate.mode`,
        code: 'invalid_aggregate_mode',
        message: unknownValueAggregateMode(mode).message,
      });
    if (typeof node.field !== 'string' || node.field === '')
      issues.push({
        path: `${path}.field`,
        code: 'field_required',
        message: 'an aggregate value reads a list field',
      });
    // The field, window and condition, checked as the aggregate rule over the same rows is.
    return [...issues, ...prefixed(validateRule(valueReads(expr)).errors, path)];
  }
  const forms = ['value', 'path', 'bind'].filter((key) => node[key] !== undefined);
  if (forms.length !== 1)
    return [
      ...unknownKeys,
      {
        path,
        code: 'invalid_value_source',
        message: 'a value source is exactly one of value, path or bind',
      },
    ];
  if ('path' in node && (typeof node.path !== 'string' || node.path === ''))
    return [
      ...unknownKeys,
      { path: `${path}.path`, code: 'invalid_path', message: 'path must be a non-empty string' },
    ];
  if ('bind' in node && typeof node.bind !== 'string')
    return [
      ...unknownKeys,
      { path: `${path}.bind`, code: 'invalid_bind', message: 'bind must be a string' },
    ];
  return [
    ...unknownKeys,
    ...prefixed(validateRule(valueReads(expr)).errors, path).map((issue) => ({
      ...issue,
      path: issue.path.replace(/\.field$/, '.path'),
    })),
  ];
};

/** A value expression's shape checked without data: each node exactly one kind, every key known,
 *  aggregate modes from VALUE_AGGREGATE_MODES, and each condition it holds (`if`, an aggregate's
 *  `filter` / `condition` / window) valid as `validateRule` sees it. */
export const validateValue = (expression: unknown): ValidationResult =>
  validationResult(validateAt(expression, '$', false));

/** validateValue's throwing form. */
export const assertValidValue = (expression: unknown): void =>
  throwIfInvalid(validateValue(expression), 'Invalid value expression');

// ─── describe ────────────────────────────────────────────────────────────────

/** Why a type can't be worked out, at the node it was found. */
class ValueTypeIssue extends Error {
  constructor(readonly issue: ValidationIssue) {
    super(`inferValueType: ${issue.path}: ${issue.message}`);
  }
}

const refuse = (path: string, code: string, message: string): never => {
  throw new ValueTypeIssue({ path, code, message });
};

const NULL_TYPE: ValueType = { kind: null, isList: false, nullable: true };

const isNumeric = (kind: FieldKind | null): boolean =>
  kind !== null && NUMERIC_KINDS.includes(kind);

const describeType = (type: ValueType): string =>
  `${type.kind ?? 'null'}${type.isList ? '[]' : ''}`;

// One type both of two values fit: null fits any, two numeric kinds read as Float.
const unify = (a: ValueType, b: ValueType, path: string): ValueType => {
  const nullable = a.nullable || b.nullable;
  if (a.kind === null && a.isList === b.isList) return { ...b, nullable };
  if (b.kind === null && a.isList === b.isList) return { ...a, nullable };
  if (a.kind === null && !a.isList) return { ...b, nullable: true };
  if (b.kind === null && !b.isList) return { ...a, nullable: true };
  if (a.isList === b.isList) {
    if (a.kind === b.kind) return { ...a, nullable };
    if (isNumeric(a.kind) && isNumeric(b.kind))
      return { kind: FieldKind.Float, isList: a.isList, nullable };
  }
  return refuse(
    path,
    'value_type_mismatch',
    `the values here are ${describeType(a)} and ${describeType(b)}`,
  );
};

const literalType = (value: unknown, path: string): ValueType => {
  if (value === null) return NULL_TYPE;
  if (typeof value === 'number')
    return {
      kind: Number.isInteger(value) ? FieldKind.Int : FieldKind.Float,
      isList: false,
      nullable: false,
    };
  if (typeof value === 'bigint') return { kind: FieldKind.BigInt, isList: false, nullable: false };
  if (typeof value === 'string') return { kind: FieldKind.String, isList: false, nullable: false };
  if (typeof value === 'boolean')
    return { kind: FieldKind.Boolean, isList: false, nullable: false };
  if (value instanceof Date) return { kind: FieldKind.DateTime, isList: false, nullable: false };
  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      if (Array.isArray(item))
        refuse(`${path}[${index}]`, 'nested_list', "a list's items are single values");
      return literalType(item, `${path}[${index}]`);
    });
    const element = items.reduce<ValueType>((acc, item) => unify(acc, item, path), {
      kind: null,
      isList: false,
      nullable: false,
    });
    return { ...element, isList: true };
  }
  return { kind: FieldKind.Json, isList: false, nullable: false };
};

// A top-level ref reads the row: bare, or `$.` (the only scope in reach).
const rowPath = (ref: string, path: string): string => {
  const scoped = parseScopeRef(ref);
  if (!scoped) return ref;
  if (scoped.depth > 1)
    refuse(path, 'scope_out_of_bounds', `'${ref}' reaches past the row a value expression reads`);
  return scoped.path;
};

const needLens = (lens: Lens | LensNarrowing | undefined, what: string): Lens | LensNarrowing => {
  if (!lens) throw new UsageError(`inferValueType needs a lens to type ${what}`);
  return lens;
};

type Resolved = { entry: FieldMapEntry; viaList: string | null; json: boolean };

const resolvePath = (lens: Lens | LensNarrowing, ref: string, path: string): Resolved => {
  const resolution = walkLensPath(lens, ref);
  if (resolution.outcome !== 'resolved')
    return refuse(
      path,
      'unresolved_path',
      `'${ref}' does not resolve through the lens (${resolution.outcome})`,
    );
  const listHop = resolution.hops
    .slice(0, -1)
    .find((hop) => isRelationEntry(hop.entry) && hop.entry.isList);
  return {
    entry: resolution.terminal.entry,
    viaList: listHop ? listHop.field : null,
    json: resolution.jsonSubPath.length > 0 || resolution.terminal.entry.type === FieldKind.Json,
  };
};

// The kind of a column, or of each value of a scalar list column.
const columnKind = (resolved: Resolved): FieldKind | null =>
  resolved.json ? FieldKind.Json : (entryKind({ ...resolved.entry, isList: false }) ?? null);

const pathType = (lens: Lens | LensNarrowing, ref: string, path: string): ValueType => {
  const resolved = resolvePath(lens, rowPath(ref, path), path);
  if (resolved.viaList)
    refuse(
      path,
      'to_many_path',
      `'${ref}' reads through the to-many relation '${resolved.viaList}'; aggregate its rows`,
    );
  if (isRelationEntry(resolved.entry))
    refuse(
      path,
      'relation_not_value',
      `'${ref}' names a relation's rows, not a value; aggregate them`,
    );
  return {
    kind: columnKind(resolved),
    isList: resolved.entry.isList === true,
    nullable: resolved.json || resolved.entry.isRequired !== true,
  };
};

// The list an aggregate reads: a to-many relation or a scalar list column.
const aggregateList = (lens: Lens | LensNarrowing, node: AggregateValue, path: string) => {
  const field = rowPath(node.field, `${path}.field`);
  const list = resolvePath(lens, field, `${path}.field`);
  if (list.viaList || list.entry.isList !== true)
    refuse(
      `${path}.field`,
      'aggregate_needs_list',
      `'${node.field}' is not a list; an aggregate reads a list`,
    );
  return { field, list };
};

// The kind of the values an aggregate reads: `aggregate.field` on each related row, or each
// value of a scalar list.
const elementKind = (
  lens: Lens | LensNarrowing,
  node: AggregateValue,
  path: string,
): FieldKind | null => {
  const { field, list } = aggregateList(lens, node, path);
  const itemField = node.aggregate.field;
  if (!isRelationEntry(list.entry)) {
    if (itemField !== undefined)
      refuse(
        `${path}.aggregate.field`,
        'invalid_aggregate_field',
        `'${node.field}' holds values, not rows`,
      );
    return columnKind(list);
  }
  if (itemField === undefined)
    return refuse(
      `${path}.aggregate.field`,
      'aggregate_field_required',
      `${node.aggregate.mode} over rows names the field it reads`,
    );
  const item = resolvePath(lens, `${field}.${itemField}`, `${path}.aggregate.field`);
  if (isRelationEntry(item.entry) || item.entry.isList)
    refuse(
      `${path}.aggregate.field`,
      'invalid_aggregate_field',
      `'${itemField}' is not one value per row`,
    );
  return columnKind(item);
};

const aggregateType = (
  lens: Lens | LensNarrowing | undefined,
  node: AggregateValue,
  path: string,
): ValueType => {
  const mode = node.aggregate.mode as ValueAggregateMode;
  if (AGGREGATE_MODE_CATALOG[mode].result === 'count') {
    // A count is a number whatever it counts; the list it counts is checked when there is a lens.
    if (lens) aggregateList(lens, node, path);
    return { kind: FieldKind.Int, isList: false, nullable: false };
  }
  const kind = elementKind(needLens(lens, `${mode} over '${node.field}'`), node, path);
  const at = `${path}.aggregate.field`;
  if (mode === 'sum' || mode === 'avg') {
    if (!isNumeric(kind))
      refuse(
        at,
        'aggregate_kind_mismatch',
        `${mode} adds numbers, not ${kind ?? 'untyped'} values`,
      );
    const sumKind = mode === 'sum' || kind === FieldKind.Decimal ? kind : FieldKind.Float;
    return { kind: sumKind, isList: false, nullable: false };
  }
  if (kind === null || !ORDERED_VALUE_KINDS.includes(kind))
    refuse(
      at,
      'aggregate_kind_mismatch',
      `${mode} orders numbers, strings and dates, not ${kind ?? 'untyped'} values`,
    );
  return { kind, isList: false, nullable: true };
};

const inferAt = (
  expr: unknown,
  lens: Lens | LensNarrowing | undefined,
  path: string,
  inList: boolean,
): ValueType => {
  const node = expr as Node;
  switch (valueExpressionShape(expr)) {
    case 'source':
      if (node.value !== undefined) return literalType(node.value, `${path}.value`);
      if (typeof node.bind === 'string')
        return refuse(
          path,
          'untyped_binding',
          `{ bind: '${node.bind}' } has no type until it is bound`,
        );
      return pathType(needLens(lens, `the path '${String(node.path)}'`), node.path as string, path);
    case 'aggregate':
      return aggregateType(lens, node as AggregateValue, path);
    case 'if': {
      const then = inferAt(node.then, lens, `${path}.then`, inList);
      // In a list a missed `if` adds nothing; anywhere else it is null.
      if (node.else === undefined) return inList ? then : unify(then, NULL_TYPE, path);
      return unify(then, inferAt(node.else, lens, `${path}.else`, inList), path);
    }
    case 'list': {
      const items = (expr as unknown[]).map((item, index) => {
        const at = `${path}[${index}]`;
        const type = inferAt(item, lens, at, true);
        if (type.isList) refuse(at, 'nested_list', "a list's items are single values");
        return type;
      });
      const element = items.reduce<ValueType>((acc, item) => unify(acc, item, path), {
        kind: null,
        isList: false,
        nullable: false,
      });
      return { ...element, isList: true };
    }
    default:
      return refuse(path, 'invalid_value_expression', invalidValueExpression(path).message);
  }
};

/**
 * The type a value expression returns, worked out without data — for a consumer to check against
 * the type it stores before saving the expression. A literal has its value's kind (a whole number
 * `Int`, any other `Float`); a path its column's kind through the lens (nullable unless the map
 * declares it required); `count` an `Int`; `sum` its column's numeric kind and `avg` a `Float`
 * (`Decimal` stays `Decimal`), never null (0 over no rows); `min` / `max` their column's kind,
 * nullable (no rows). An `if`'s branches and a list's items must agree (two numeric kinds read as
 * `Float`; a missing `else` is null). `lens` is needed wherever a path's kind is read. Throws on
 * an expression that has no type: a path that does not resolve, reads through a to-many relation
 * or names rows, an aggregate over something that isn't a list, branches that disagree, a binding.
 */
export const inferValueType = (
  expression: ValueExpression,
  lens?: Lens | LensNarrowing,
): ValueType => {
  assertValidValue(expression);
  return inferAt(expression, lens, '$', false);
};

/**
 * The finest clock unit a value expression's answer can change by while its data stays the same —
 * `clockUnit` over every condition it holds (an `if`, an aggregate's `filter` / `condition`), so
 * an aggregate over the last 90 days reads `day`. Null when it reads no clock. Throws, as
 * `clockUnit` does, on a unit finer than `clock.finestUnit`.
 */
export const valueClockUnit = (expression: ValueExpression): ClockUnit | null =>
  clockUnit(valueReads(expression));

/** A value expression under a lens: its type, the dotted paths it reads from the row (a relation's
 *  rows under the relation: `fanMissions.status`), its clock unit, and every problem the
 *  validator, the lens gate and type inference find. Never throws on a bad expression. */
export type ValueDescription = {
  type: ValueType | null;
  paths: string[];
  clockUnit: ClockUnit | null;
  errors: ValidationIssue[];
};

export const describeValue = (
  expression: ValueExpression,
  lensOrNarrowing: Lens | LensNarrowing,
): ValueDescription => {
  const shapeErrors = validateValue(expression).errors;
  if (shapeErrors.length > 0)
    return { type: null, paths: [], clockUnit: null, errors: shapeErrors };
  const reads: Condition = valueReads(expression);
  const errors = [...validateRuleInLens(reads, lensOrNarrowing).errors];
  let type: ValueType | null = null;
  try {
    type = inferAt(expression, lensOrNarrowing, '$', false);
  } catch (error) {
    if (!(error instanceof ValueTypeIssue)) throw error;
    errors.push(error.issue);
  }
  let unit: ClockUnit | null = null;
  try {
    unit = clockUnit(reads);
  } catch (error) {
    errors.push({ path: '$', code: 'clock_unit_below_floor', message: (error as Error).message });
  }
  return { type, paths: readPaths(reads).sort(), clockUnit: unit, errors };
};
