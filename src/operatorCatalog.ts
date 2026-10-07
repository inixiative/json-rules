import { ArrayOperator, DateOperator, Operator } from './operator';

export const FieldKind = {
  String: 'String',
  Boolean: 'Boolean',
  Int: 'Int',
  BigInt: 'BigInt',
  Float: 'Float',
  Decimal: 'Decimal',
  DateTime: 'DateTime',
  Json: 'Json',
  Bytes: 'Bytes',
  Enum: 'Enum',
} as const;

export type FieldKind = (typeof FieldKind)[keyof typeof FieldKind];

export const NUMERIC_KINDS: readonly FieldKind[] = ['Int', 'Float', 'Decimal', 'BigInt'];
export const ORDERABLE_KINDS: readonly FieldKind[] = ['String', ...NUMERIC_KINDS, 'DateTime'];
export const STRINGY_KINDS: readonly FieldKind[] = ['String'];
export const EQUATABLE_KINDS: readonly FieldKind[] = [
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Enum',
];
export const ALL_KINDS: readonly FieldKind[] = Object.values(FieldKind);
// Any column can be nullable — nullability is a per-field property, not a per-kind one.
// isEmpty/notEmpty ("null or empty string") are therefore valid on every kind; the
// SQL/Prisma compilers emit meaningful `IS NULL OR = ''` for any nullable column.
export const NULLABLE_KINDS: readonly FieldKind[] = ALL_KINDS;

export const RuleTarget = {
  check: 'check',
  toPrisma: 'toPrisma',
  toSql: 'toSql',
} as const;

export type RuleTarget = (typeof RuleTarget)[keyof typeof RuleTarget];

const ALL_TARGETS: readonly RuleTarget[] = ['check', 'toPrisma', 'toSql'];
const NON_SQL_TARGETS: readonly RuleTarget[] = ['check', 'toPrisma'];
const NON_PRISMA_TARGETS: readonly RuleTarget[] = ['check', 'toSql'];

export const ValueShape = {
  none: 'none',
  scalar: 'scalar',
  ordered: 'ordered',
  array: 'array',
  string: 'string',
  pattern: 'pattern',
  range: 'range',
  dateValue: 'dateValue',
  dateRange: 'dateRange',
  dateWindow: 'dateWindow',
  dayList: 'dayList',
  count: 'count',
  predicate: 'predicate',
} as const;

export type ValueShape = (typeof ValueShape)[keyof typeof ValueShape];

export type CatalogEntry = {
  kinds: readonly FieldKind[];
  targets: readonly RuleTarget[];
  valueShape: ValueShape;
  acceptsExpr?: boolean;
};

export const FIELD_OPERATOR_CATALOG: Record<Operator, CatalogEntry> = {
  [Operator.equals]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'scalar' },
  [Operator.notEquals]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'scalar' },
  [Operator.lessThan]: { kinds: ORDERABLE_KINDS, targets: ALL_TARGETS, valueShape: 'ordered' },
  [Operator.lessThanEquals]: {
    kinds: ORDERABLE_KINDS,
    targets: ALL_TARGETS,
    valueShape: 'ordered',
  },
  [Operator.greaterThan]: { kinds: ORDERABLE_KINDS, targets: ALL_TARGETS, valueShape: 'ordered' },
  [Operator.greaterThanEquals]: {
    kinds: ORDERABLE_KINDS,
    targets: ALL_TARGETS,
    valueShape: 'ordered',
  },
  [Operator.in]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'array' },
  [Operator.notIn]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'array' },
  [Operator.contains]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.notContains]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.startsWith]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.endsWith]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.matches]: { kinds: STRINGY_KINDS, targets: NON_PRISMA_TARGETS, valueShape: 'pattern' },
  [Operator.notMatches]: {
    kinds: STRINGY_KINDS,
    targets: NON_PRISMA_TARGETS,
    valueShape: 'pattern',
  },
  [Operator.between]: { kinds: ORDERABLE_KINDS, targets: ALL_TARGETS, valueShape: 'range' },
  [Operator.notBetween]: { kinds: ORDERABLE_KINDS, targets: ALL_TARGETS, valueShape: 'range' },
  [Operator.isEmpty]: { kinds: NULLABLE_KINDS, targets: ALL_TARGETS, valueShape: 'none' },
  [Operator.notEmpty]: { kinds: NULLABLE_KINDS, targets: ALL_TARGETS, valueShape: 'none' },
  [Operator.exists]: { kinds: ALL_KINDS, targets: ALL_TARGETS, valueShape: 'none' },
  [Operator.notExists]: { kinds: ALL_KINDS, targets: ALL_TARGETS, valueShape: 'none' },
};

export const DATE_OPERATOR_CATALOG: Record<DateOperator, CatalogEntry> = {
  [DateOperator.before]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
  },
  [DateOperator.after]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
  },
  [DateOperator.onOrBefore]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
  },
  [DateOperator.onOrAfter]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
  },
  [DateOperator.notBefore]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
  },
  [DateOperator.notAfter]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
  },
  [DateOperator.within]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateWindow',
    acceptsExpr: true,
  },
  [DateOperator.notWithin]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateWindow',
    acceptsExpr: true,
  },
  [DateOperator.between]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateRange',
    acceptsExpr: true,
  },
  [DateOperator.notBetween]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateRange',
    acceptsExpr: true,
  },
  [DateOperator.dayIn]: {
    kinds: ['DateTime'],
    targets: NON_PRISMA_TARGETS,
    valueShape: 'dayList',
    acceptsExpr: false,
  },
  [DateOperator.dayNotIn]: {
    kinds: ['DateTime'],
    targets: NON_PRISMA_TARGETS,
    valueShape: 'dayList',
    acceptsExpr: false,
  },
};

export type ArrayCatalogEntry = {
  targets: readonly RuleTarget[];
  valueShape: ValueShape;
};

export const ARRAY_OPERATOR_CATALOG: Record<ArrayOperator, ArrayCatalogEntry> = {
  [ArrayOperator.all]: { targets: NON_SQL_TARGETS, valueShape: 'predicate' },
  [ArrayOperator.any]: { targets: NON_SQL_TARGETS, valueShape: 'predicate' },
  [ArrayOperator.none]: { targets: NON_SQL_TARGETS, valueShape: 'predicate' },
  [ArrayOperator.atLeast]: { targets: NON_SQL_TARGETS, valueShape: 'count' },
  [ArrayOperator.atMost]: { targets: NON_SQL_TARGETS, valueShape: 'count' },
  [ArrayOperator.exactly]: { targets: NON_SQL_TARGETS, valueShape: 'count' },
  [ArrayOperator.empty]: { targets: ALL_TARGETS, valueShape: 'none' },
  [ArrayOperator.notEmpty]: { targets: ALL_TARGETS, valueShape: 'none' },
};

export const WindowSupport = {
  full: 'full',
  extremal: 'extremal',
  none: 'none',
} as const;

export type WindowSupport = (typeof WindowSupport)[keyof typeof WindowSupport];

export const WINDOW_SELECTOR = {
  fields: ['filter', 'orderBy', 'take', 'skip'],
  sortDirs: ['asc', 'desc'],
  support: {
    array: {
      check: WindowSupport.full,
      toPrisma: WindowSupport.extremal,
      toSql: WindowSupport.none,
    },
    aggregate: {
      check: WindowSupport.full,
      toPrisma: WindowSupport.none,
      toSql: WindowSupport.none,
    },
  },
} as const;

export type WindowRuleType = keyof typeof WINDOW_SELECTOR.support;

export const getWindowSupport = (ruleType: WindowRuleType, target: RuleTarget): WindowSupport =>
  WINDOW_SELECTOR.support[ruleType][target];

const AGGREGATE_SINGLE_VALUE_SHAPES: ReadonlySet<ValueShape> = new Set(['scalar', 'ordered']);
const AGGREGATE_RANGE_VALUE_SHAPES: ReadonlySet<ValueShape> = new Set(['range']);

export const AGGREGATE_OPERATORS: readonly Operator[] = [
  Operator.equals,
  Operator.notEquals,
  Operator.lessThan,
  Operator.lessThanEquals,
  Operator.greaterThan,
  Operator.greaterThanEquals,
  Operator.between,
  Operator.notBetween,
];

/** Aggregate threshold comparisons a target cannot compile. `toPrisma()` builds the
 *  threshold as a Prisma `having` filter, which has no complement for a range, so
 *  `notBetween` is unavailable there — `check()` and `toSql()` both handle it. */
const AGGREGATE_UNSUPPORTED: Partial<Record<RuleTarget, readonly Operator[]>> = {
  toPrisma: [Operator.notBetween],
};

/** The aggregate threshold comparisons `target` can compile — all of them when no
 *  target is given. The one source for both the validator's rejection and a builder's
 *  threshold picker, so neither has to restate which target drops which operator. */
export const getAggregateOperators = (target?: RuleTarget): readonly Operator[] => {
  const unsupported = target === undefined ? undefined : AGGREGATE_UNSUPPORTED[target];
  return unsupported === undefined
    ? AGGREGATE_OPERATORS
    : AGGREGATE_OPERATORS.filter((op) => !unsupported.includes(op));
};

export const isAggregateSingleOperator = (operator: Operator): boolean => {
  const entry = FIELD_OPERATOR_CATALOG[operator];
  if (!entry) return false;
  return AGGREGATE_SINGLE_VALUE_SHAPES.has(entry.valueShape);
};

export const isAggregateRangeOperator = (operator: Operator): boolean => {
  const entry = FIELD_OPERATOR_CATALOG[operator];
  if (!entry) return false;
  return AGGREGATE_RANGE_VALUE_SHAPES.has(entry.valueShape);
};

export const getValueShape = (operator: Operator | DateOperator | ArrayOperator): ValueShape => {
  if (Object.hasOwn(FIELD_OPERATOR_CATALOG, operator)) {
    return FIELD_OPERATOR_CATALOG[operator as Operator].valueShape;
  }
  if (Object.hasOwn(DATE_OPERATOR_CATALOG, operator)) {
    return DATE_OPERATOR_CATALOG[operator as DateOperator].valueShape;
  }
  if (Object.hasOwn(ARRAY_OPERATOR_CATALOG, operator)) {
    return ARRAY_OPERATOR_CATALOG[operator as ArrayOperator].valueShape;
  }
  throw new Error(`Unknown operator: ${operator}`);
};

export const isOperatorSupportedForTarget = (
  operator: Operator | DateOperator | ArrayOperator,
  target: RuleTarget,
): boolean => {
  if (Object.hasOwn(FIELD_OPERATOR_CATALOG, operator)) {
    return FIELD_OPERATOR_CATALOG[operator as Operator].targets.includes(target);
  }
  if (Object.hasOwn(DATE_OPERATOR_CATALOG, operator)) {
    return DATE_OPERATOR_CATALOG[operator as DateOperator].targets.includes(target);
  }
  if (Object.hasOwn(ARRAY_OPERATOR_CATALOG, operator)) {
    return ARRAY_OPERATOR_CATALOG[operator as ArrayOperator].targets.includes(target);
  }
  return false;
};

export const getOperatorsForKind = (
  kind: FieldKind,
  target?: RuleTarget,
): { field: Operator[]; date: DateOperator[] } => {
  const field = (Object.keys(FIELD_OPERATOR_CATALOG) as Operator[]).filter((op) => {
    const entry = FIELD_OPERATOR_CATALOG[op];
    if (!entry.kinds.includes(kind)) return false;
    if (target && !entry.targets.includes(target)) return false;
    return true;
  });
  const date = (Object.keys(DATE_OPERATOR_CATALOG) as DateOperator[]).filter((op) => {
    const entry = DATE_OPERATOR_CATALOG[op];
    if (!entry.kinds.includes(kind)) return false;
    if (target && !entry.targets.includes(target)) return false;
    return true;
  });
  return { field, date };
};

export const getArrayOperators = (target?: RuleTarget): ArrayOperator[] => {
  return (Object.keys(ARRAY_OPERATOR_CATALOG) as ArrayOperator[]).filter((op) => {
    if (!target) return true;
    return ARRAY_OPERATOR_CATALOG[op].targets.includes(target);
  });
};

// --- Operator sets ---------------------------------------------------------------------------
// Every set of operators the rails and validation branch on, defined here once. Sets that
// follow from an entry's value shape are derived; the rest are listed.

const OPERATOR_ENTRIES: readonly [string, CatalogEntry][] = [
  ...Object.entries(FIELD_OPERATOR_CATALOG),
  ...Object.entries(DATE_OPERATOR_CATALOG),
];
const withShape = (...shapes: ValueShape[]): readonly string[] =>
  OPERATOR_ENTRIES.flatMap(([operator, entry]) =>
    shapes.includes(entry.valueShape) ? [operator] : [],
  );

/** Operators that read no comparison value. */
export const NO_VALUE_OPERATORS = withShape('none');
/** Field comparisons with an order: `<`, `<=`, `>`, `>=`. */
export const ORDERED_OPERATORS = withShape('ordered');
/** A window expression (`within`), not a pair. */
export const WINDOW_OPERATORS = withShape('dateWindow');
/** Operators that compare against two ends. */
export const RANGE_OPERATORS = withShape('range', 'dateRange', 'dateWindow');
/** Operators with a point to move: the comparisons and both ends of a pair. */
export const OFFSET_OPERATORS = withShape('scalar', 'ordered', 'range', 'dateValue', 'dateRange');

/** The negations: each is the complement of its positive form and keeps NULL fields
 *  (the 2.19.0 ruling). */
export const NEGATED_OPERATORS: readonly string[] = [
  Operator.notEquals,
  Operator.notIn,
  Operator.notContains,
  Operator.notMatches,
  Operator.notBetween,
  DateOperator.notBefore,
  DateOperator.notAfter,
  DateOperator.notWithin,
  DateOperator.notBetween,
  DateOperator.dayNotIn,
];
/** Negations of a two-ended range. */
export const NEGATED_RANGE_OPERATORS = NEGATED_OPERATORS.filter((op) =>
  RANGE_OPERATORS.includes(op),
);
/** Negated comparisons an offset can move; with nothing to compare against they still keep a
 *  null field. */
export const NEGATED_COMPARISON_OPERATORS = NEGATED_OPERATORS.filter((op) =>
  OFFSET_OPERATORS.includes(op),
);
/** Negations of one literal (`notEquals`, `notContains`). */
export const NEGATED_SINGLE_VALUE_OPERATORS = NEGATED_OPERATORS.filter((op) =>
  withShape('scalar', 'string').includes(op),
);

/** Comparisons that bound a field from above / below — what a window's extremal rewrite reads. */
export const UPPER_BOUND_OPERATORS: readonly string[] = [
  DateOperator.before,
  DateOperator.onOrBefore,
  Operator.lessThan,
  Operator.lessThanEquals,
];
export const LOWER_BOUND_OPERATORS: readonly string[] = [
  DateOperator.after,
  DateOperator.onOrAfter,
  Operator.greaterThan,
  Operator.greaterThanEquals,
];

// --- Kind sets -------------------------------------------------------------------------------

/** Kinds a calendar unit amount can read: whole numbers. */
export const INTEGER_KINDS: readonly FieldKind[] = ['Int', 'BigInt'];
/** Kinds check() coerces a literal to (see coerceScalar in src/field.ts). */
export const COERCIBLE_KINDS: readonly FieldKind[] = [
  ...NUMERIC_KINDS,
  'DateTime',
  'Boolean',
  'String',
];
/** Kinds whose literal the compilers coerce exactly as check() does — Prisma rejects a string on
 *  Int/Float/Boolean; BigInt compares as Int. Decimal keeps its literal: Prisma and Postgres take
 *  the numeric string losslessly, and a JS number would not. */
export const COMPILE_COERCED_KINDS: readonly FieldKind[] = [
  'Int',
  'BigInt',
  'Float',
  'Boolean',
  'String',
];

/** Value shapes that take one literal. */
export const SINGLE_VALUE_SHAPES: readonly ValueShape[] = ['scalar', 'ordered', 'string'];

// --- Date units ------------------------------------------------------------------------------

/** Each relative unit: the Postgres interval field it adds to, its size there, and whether it is
 *  a calendar unit (whole steps). Applied months, then days, then time, as Postgres does. */
export const RELATIVE_UNITS = {
  years: { interval: 'months', factor: 12, calendar: true },
  quarters: { interval: 'months', factor: 3, calendar: true },
  months: { interval: 'months', factor: 1, calendar: true },
  weeks: { interval: 'days', factor: 7, calendar: true },
  days: { interval: 'days', factor: 1, calendar: true },
  hours: { interval: 'secs', factor: 3600, calendar: false },
  minutes: { interval: 'secs', factor: 60, calendar: false },
  seconds: { interval: 'secs', factor: 1, calendar: false },
} as const;
export type RelativeUnit = keyof typeof RELATIVE_UNITS;
export const INTERVAL_FIELDS = ['months', 'days', 'secs'] as const;
export const isRelativeUnit = (unit: string): unit is RelativeUnit =>
  Object.hasOwn(RELATIVE_UNITS, unit);
export const isCalendarUnit = (unit: string): boolean =>
  isRelativeUnit(unit) && RELATIVE_UNITS[unit].calendar;

export const PERIOD_UNITS: readonly string[] = [
  'year',
  'quarter',
  'month',
  'week',
  'isoWeek',
  'day',
  'hour',
  'minute',
  'second',
];

// --- Weekdays -------------------------------------------------------------------------------

/** Weekday names in Postgres `EXTRACT(DOW)` order: sunday is 0. */
export const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export const isDayName = (name: string): boolean =>
  (DAY_NAMES as readonly string[]).includes(name.toLowerCase());
