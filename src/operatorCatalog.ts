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
const ORDERABLE_KINDS: readonly FieldKind[] = ['String', ...NUMERIC_KINDS, 'DateTime'];
const STRINGY_KINDS: readonly FieldKind[] = ['String'];
const EQUATABLE_KINDS: readonly FieldKind[] = [
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
const NULLABLE_KINDS: readonly FieldKind[] = ALL_KINDS;

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

/** How an ordered operator compares its field with its one operand (a count, its matches). */
export type Comparator = 'lt' | 'lte' | 'gt' | 'gte' | 'equals';

export type CatalogEntry = {
  kinds: readonly FieldKind[];
  targets: readonly RuleTarget[];
  valueShape: ValueShape;
  acceptsExpr?: boolean;
  comparator?: Comparator;
};

export const FIELD_OPERATOR_CATALOG: Record<Operator, CatalogEntry> = {
  [Operator.equals]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'scalar' },
  [Operator.notEquals]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'scalar' },
  [Operator.lessThan]: {
    kinds: ORDERABLE_KINDS,
    targets: ALL_TARGETS,
    valueShape: 'ordered',
    comparator: 'lt',
  },
  [Operator.lessThanEquals]: {
    kinds: ORDERABLE_KINDS,
    targets: ALL_TARGETS,
    valueShape: 'ordered',
    comparator: 'lte',
  },
  [Operator.greaterThan]: {
    kinds: ORDERABLE_KINDS,
    targets: ALL_TARGETS,
    valueShape: 'ordered',
    comparator: 'gt',
  },
  [Operator.greaterThanEquals]: {
    kinds: ORDERABLE_KINDS,
    targets: ALL_TARGETS,
    valueShape: 'ordered',
    comparator: 'gte',
  },
  [Operator.in]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'array' },
  [Operator.notIn]: { kinds: EQUATABLE_KINDS, targets: ALL_TARGETS, valueShape: 'array' },
  [Operator.contains]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.notContains]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.startsWith]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.notStartsWith]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.endsWith]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
  [Operator.notEndsWith]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'string' },
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
    comparator: 'lt',
  },
  [DateOperator.after]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
    comparator: 'gt',
  },
  [DateOperator.onOrBefore]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
    comparator: 'lte',
  },
  [DateOperator.onOrAfter]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
    comparator: 'gte',
  },
  [DateOperator.notBefore]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
    comparator: 'gte',
  },
  [DateOperator.notAfter]: {
    kinds: ['DateTime'],
    targets: ALL_TARGETS,
    valueShape: 'dateValue',
    acceptsExpr: true,
    comparator: 'lte',
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
  comparator?: Comparator;
};

export const ARRAY_OPERATOR_CATALOG: Record<ArrayOperator, ArrayCatalogEntry> = {
  [ArrayOperator.all]: { targets: NON_SQL_TARGETS, valueShape: 'predicate' },
  [ArrayOperator.any]: { targets: NON_SQL_TARGETS, valueShape: 'predicate' },
  [ArrayOperator.none]: { targets: NON_SQL_TARGETS, valueShape: 'predicate' },
  [ArrayOperator.atLeast]: { targets: NON_SQL_TARGETS, valueShape: 'count', comparator: 'gte' },
  [ArrayOperator.atMost]: { targets: NON_SQL_TARGETS, valueShape: 'count', comparator: 'lte' },
  [ArrayOperator.exactly]: { targets: NON_SQL_TARGETS, valueShape: 'count', comparator: 'equals' },
  [ArrayOperator.empty]: { targets: ALL_TARGETS, valueShape: 'none' },
  [ArrayOperator.notEmpty]: { targets: ALL_TARGETS, valueShape: 'none' },
};

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

/** The threshold comparisons an aggregate takes; every target compiles all of them. */
export const getAggregateOperators = (): readonly Operator[] => AGGREGATE_OPERATORS;

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

/** Which catalog an operator belongs to — `between` is both a field and a date operator. */
export type OperatorFamily = 'field' | 'date' | 'array';

const CATALOGS: Record<OperatorFamily, Record<string, CatalogEntry | ArrayCatalogEntry>> = {
  field: FIELD_OPERATOR_CATALOG,
  date: DATE_OPERATOR_CATALOG,
  array: ARRAY_OPERATOR_CATALOG,
};

/** An operator's catalog entry within its family; undefined when the family doesn't have it. */
export const catalogEntry = (
  operator: string,
  family: OperatorFamily,
): CatalogEntry | ArrayCatalogEntry | undefined =>
  Object.hasOwn(CATALOGS[family], operator) ? CATALOGS[family][operator] : undefined;

/** How an operator compares its field with one operand; undefined when it doesn't. */
export const comparatorOf = (operator: string, family: OperatorFamily): Comparator | undefined =>
  catalogEntry(operator, family)?.comparator;

export const getValueShape = (operator: string, family: OperatorFamily): ValueShape => {
  const entry = catalogEntry(operator, family);
  if (!entry) throw new Error(`Unknown ${family} operator: ${operator}`);
  return entry.valueShape;
};

export const isOperatorSupportedForTarget = (
  operator: string,
  family: OperatorFamily,
  target: RuleTarget,
): boolean => catalogEntry(operator, family)?.targets.includes(target) ?? false;

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
/** Operators a null operand leaves with nothing to compare against — unlike `equals` /
 *  `notEquals`, where null is the is-null sentinel. */
export const OPERAND_OPERATORS = withShape('ordered', 'string', 'pattern', 'array');
/** Containment — of a substring, or of a list's member: `contains` / `notContains`. */
export const CONTAINS_OPERATORS: readonly string[] = [Operator.contains, Operator.notContains];
/** Equality with one value: `equals` / `notEquals`. */
export const EQUALITY_OPERATORS = withShape('scalar');
/** Membership in a list: `in` / `notIn`. */
export const SET_OPERATORS = withShape('array');
/** Exact equality and membership: what a column answers by value, case-sensitively. */
export const EXACT_OPERATORS = withShape('scalar', 'array');
/** Weekday lists: `dayIn` / `dayNotIn`. */
export const DAY_LIST_OPERATORS = withShape('dayList');
/** Date ranges between two points: date `between` / `notBetween`. */
export const DATE_RANGE_OPERATORS = withShape('dateRange');
/** Operators with a point to move: the comparisons and both ends of a pair. */
export const OFFSET_OPERATORS = withShape('scalar', 'ordered', 'range', 'dateValue', 'dateRange');

const arrayWithShape = (...shapes: ValueShape[]): readonly string[] =>
  Object.entries(ARRAY_OPERATOR_CATALOG).flatMap(([operator, entry]) =>
    shapes.includes(entry.valueShape) ? [operator] : [],
  );
/** Array operators that count matching elements. */
export const ARRAY_COUNT_OPERATORS = arrayWithShape('count');
/** Array operators that test each element against a condition. */
export const ARRAY_CONDITION_OPERATORS = arrayWithShape('predicate', 'count');
/** Array operators a broader condition only widens: more matching elements never make them false. */
export const ARRAY_MONOTONE_OPERATORS: readonly string[] = [
  ArrayOperator.any,
  ArrayOperator.atLeast,
];

/** The negations: each is the complement of its positive form and keeps NULL fields
 *  (the 2.19.0 ruling). */
export const NEGATED_OPERATORS: readonly string[] = [
  Operator.notEquals,
  Operator.notIn,
  Operator.notContains,
  Operator.notStartsWith,
  Operator.notEndsWith,
  Operator.notMatches,
  Operator.notBetween,
  DateOperator.notBefore,
  DateOperator.notAfter,
  DateOperator.notWithin,
  DateOperator.notBetween,
  DateOperator.dayNotIn,
];
/** Negations of a string operator: `notContains`, `notStartsWith`, `notEndsWith`. */
export const NEGATED_STRING_OPERATORS = NEGATED_OPERATORS.filter((op) =>
  withShape('string').includes(op),
);
/** Negations of a two-ended range. */
export const NEGATED_RANGE_OPERATORS = NEGATED_OPERATORS.filter((op) =>
  RANGE_OPERATORS.includes(op),
);

/** Comparisons that bound a field from above / below — what a window's extremal rewrite reads. */
const bounding = (...comparators: Comparator[]): readonly string[] =>
  OPERATOR_ENTRIES.flatMap(([operator, entry]) =>
    entry.comparator &&
    comparators.includes(entry.comparator) &&
    !NEGATED_OPERATORS.includes(operator)
      ? [operator]
      : [],
  );
export const UPPER_BOUND_OPERATORS = bounding('lt', 'lte');
export const LOWER_BOUND_OPERATORS = bounding('gt', 'gte');

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

// --- Complements -----------------------------------------------------------------------------
// Each operator's complement under check(). A negation keeps NULL fields (the 2.19.0 ruling), so
// a flip is exact; an ordered comparison has no negated twin, so its complement is the opposite
// comparison or an absent field.

export const COMPLEMENT_OPERATORS: Readonly<Record<string, string>> = {
  [Operator.equals]: Operator.notEquals,
  [Operator.notEquals]: Operator.equals,
  [Operator.in]: Operator.notIn,
  [Operator.notIn]: Operator.in,
  [Operator.contains]: Operator.notContains,
  [Operator.notContains]: Operator.contains,
  [Operator.startsWith]: Operator.notStartsWith,
  [Operator.notStartsWith]: Operator.startsWith,
  [Operator.endsWith]: Operator.notEndsWith,
  [Operator.notEndsWith]: Operator.endsWith,
  [Operator.matches]: Operator.notMatches,
  [Operator.notMatches]: Operator.matches,
  [Operator.between]: Operator.notBetween,
  [Operator.notBetween]: Operator.between,
  [Operator.isEmpty]: Operator.notEmpty,
  [Operator.notEmpty]: Operator.isEmpty,
  [Operator.exists]: Operator.notExists,
  [Operator.notExists]: Operator.exists,
};

export const COMPLEMENT_DATE_OPERATORS: Readonly<Record<string, string>> = {
  [DateOperator.before]: DateOperator.notBefore,
  [DateOperator.notBefore]: DateOperator.before,
  [DateOperator.after]: DateOperator.notAfter,
  [DateOperator.notAfter]: DateOperator.after,
  [DateOperator.within]: DateOperator.notWithin,
  [DateOperator.notWithin]: DateOperator.within,
  [DateOperator.between]: DateOperator.notBetween,
  [DateOperator.notBetween]: DateOperator.between,
  [DateOperator.dayIn]: DateOperator.dayNotIn,
  [DateOperator.dayNotIn]: DateOperator.dayIn,
};

/** The opposite of a comparison with no negated twin: its complement, less the absent field. */
export const OPPOSITE_OPERATORS: Readonly<Record<string, string>> = {
  [Operator.lessThan]: Operator.greaterThanEquals,
  [Operator.lessThanEquals]: Operator.greaterThan,
  [Operator.greaterThan]: Operator.lessThanEquals,
  [Operator.greaterThanEquals]: Operator.lessThan,
  [DateOperator.onOrBefore]: DateOperator.after,
  [DateOperator.onOrAfter]: DateOperator.before,
};
