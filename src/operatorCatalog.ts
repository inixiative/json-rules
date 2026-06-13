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
  [Operator.isEmpty]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'none' },
  [Operator.notEmpty]: { kinds: STRINGY_KINDS, targets: ALL_TARGETS, valueShape: 'none' },
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
  [DateOperator.within]: {
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
