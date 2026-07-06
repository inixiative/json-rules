import type { ArrayOperator, DateOperator, Operator } from './operator.ts';
import type { FieldKind } from './operatorCatalog.ts';

type OperatorValues = typeof import('./operator.ts').Operator;
type ArrayOperatorValues = typeof import('./operator.ts').ArrayOperator;
type DateOperatorValues = typeof import('./operator.ts').DateOperator;

export type RuleScalar = string | number | boolean | null | undefined;

export type AggregateMode = 'sum' | 'avg';

export type RuleValue = RuleScalar | Date | RegExp | RuleValue[] | { [key: string]: RuleValue };
export type OrderedRuleValue = string | number | Date;

export type DateInputValue = string | number | Date;

// --- Relative & calendar date expressions (v2.6.0) ---
// Positive magnitudes only; direction lives in the keyword. Units are dayjs words.
export type RelativeUnits = {
  years?: number;
  quarters?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
};
export type PeriodUnit =
  | 'year'
  | 'quarter'
  | 'month'
  | 'week'
  | 'isoWeek'
  | 'day'
  | 'hour'
  | 'minute'
  | 'second';

// Point expressions — resolve to a single instant.
export type RollingExpr = { ago: RelativeUnits } | { ahead: RelativeUnits };
export type PeriodExpr = { this: PeriodUnit } | { last: PeriodUnit } | { next: PeriodUnit };
export type EdgeExpr = { start: PeriodExpr } | { end: PeriodExpr };

// A date expression is either a point (rolling/edge) or a range (period/rolling).
export type DateExpr = RollingExpr | PeriodExpr | EdgeExpr;

export type DateInputOrExpr = DateInputValue | DateExpr;

export type DateRuleValue =
  | DateInputValue
  | DateExpr
  | [DateInputOrExpr, DateInputOrExpr]
  | string[];

export type WeekStart = 'monday' | 'sunday';
// The anchoring timezone for naive datetimes. Either a literal IANA zone string, or a
// bound reference resolved from the evaluation's `bindings` (same bind mechanism as rule
// values). Stays ONE zone per evaluation; absolute instants never consult it.
export type TimeZoneConfig = string | { bind: string };
export type DateConfig = {
  now?: DateInputValue;
  timeZone?: TimeZoneConfig;
  weekStart?: WeekStart;
};

type ValueSource<TValue> =
  | { value: TValue; path?: never; bind?: never }
  | { path: string; value?: never; bind?: never }
  | { bind: string; value?: never; path?: never };
type NoValueSource = { value?: never; path?: never };
type RuleBase<TOperator extends Operator> = {
  field: string;
  operator: TOperator;
  error?: string;
  caseInsensitive?: boolean;
};
type DateRuleBase<TOperator extends DateOperator> = {
  field: string;
  dateOperator: TOperator;
  error?: string;
};

export type StrictEqualityRule<TValue = RuleValue> =
  | (RuleBase<OperatorValues['equals']> & ValueSource<TValue>)
  | (RuleBase<OperatorValues['notEquals']> & ValueSource<TValue>);

export type StrictOrderedComparisonRule =
  | (RuleBase<OperatorValues['lessThan']> & ValueSource<OrderedRuleValue>)
  | (RuleBase<OperatorValues['lessThanEquals']> & ValueSource<OrderedRuleValue>)
  | (RuleBase<OperatorValues['greaterThan']> & ValueSource<OrderedRuleValue>)
  | (RuleBase<OperatorValues['greaterThanEquals']> & ValueSource<OrderedRuleValue>);

export type StrictMembershipRule<TValue = RuleValue> =
  | (RuleBase<OperatorValues['in']> & ValueSource<TValue[]>)
  | (RuleBase<OperatorValues['notIn']> & ValueSource<TValue[]>);

export type StrictContainsRule<TValue = RuleValue> =
  | (RuleBase<OperatorValues['contains']> & ValueSource<TValue>)
  | (RuleBase<OperatorValues['notContains']> & ValueSource<TValue>);

export type StrictPatternRule =
  | (RuleBase<OperatorValues['matches']> & ValueSource<RegExp | string>)
  | (RuleBase<OperatorValues['notMatches']> & ValueSource<RegExp | string>);

export type StrictStringBoundaryRule =
  | (RuleBase<OperatorValues['startsWith']> & ValueSource<string>)
  | (RuleBase<OperatorValues['endsWith']> & ValueSource<string>);

export type StrictRangeRule =
  | (RuleBase<OperatorValues['between']> & ValueSource<[OrderedRuleValue, OrderedRuleValue]>)
  | (RuleBase<OperatorValues['notBetween']> & ValueSource<[OrderedRuleValue, OrderedRuleValue]>);

export type StrictPresenceRule =
  | (RuleBase<OperatorValues['isEmpty']> & NoValueSource)
  | (RuleBase<OperatorValues['notEmpty']> & NoValueSource)
  | (RuleBase<OperatorValues['exists']> & NoValueSource)
  | (RuleBase<OperatorValues['notExists']> & NoValueSource);

export type StrictRule<TValue = RuleValue> =
  | StrictEqualityRule<TValue>
  | StrictOrderedComparisonRule
  | StrictMembershipRule<TValue>
  | StrictContainsRule<TValue>
  | StrictPatternRule
  | StrictStringBoundaryRule
  | StrictRangeRule
  | StrictPresenceRule;

type ArrayRuleBase<TOperator extends ArrayOperator> = {
  field?: string;
  arrayOperator: TOperator;
  error?: string;
};

export type StrictArrayPredicateRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | (ArrayRuleBase<ArrayOperatorValues['all']> & {
      condition: StrictCondition<TRuleValue, TDateValue>;
      count?: never;
    })
  | (ArrayRuleBase<ArrayOperatorValues['any']> & {
      condition: StrictCondition<TRuleValue, TDateValue>;
      count?: never;
    })
  | (ArrayRuleBase<ArrayOperatorValues['none']> & {
      condition: StrictCondition<TRuleValue, TDateValue>;
      count?: never;
    });

export type StrictArrayCountRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | (ArrayRuleBase<ArrayOperatorValues['atLeast']> & {
      condition?: StrictCondition<TRuleValue, TDateValue>;
      count?: number;
    })
  | (ArrayRuleBase<ArrayOperatorValues['atMost']> & {
      condition?: StrictCondition<TRuleValue, TDateValue>;
      count?: number;
    })
  | (ArrayRuleBase<ArrayOperatorValues['exactly']> & {
      condition?: StrictCondition<TRuleValue, TDateValue>;
      count?: number;
    });

export type StrictArrayPresenceRule =
  | (ArrayRuleBase<ArrayOperatorValues['empty']> & {
      condition?: never;
      count?: never;
    })
  | (ArrayRuleBase<ArrayOperatorValues['notEmpty']> & {
      condition?: never;
      count?: never;
    });

export type StrictArrayRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | StrictArrayPredicateRule<TRuleValue, TDateValue>
  | StrictArrayCountRule<TRuleValue, TDateValue>
  | StrictArrayPresenceRule;

export type StrictDateComparisonRule =
  | (DateRuleBase<DateOperatorValues['before']> & ValueSource<DateInputValue>)
  | (DateRuleBase<DateOperatorValues['after']> & ValueSource<DateInputValue>)
  | (DateRuleBase<DateOperatorValues['onOrBefore']> & ValueSource<DateInputValue>)
  | (DateRuleBase<DateOperatorValues['onOrAfter']> & ValueSource<DateInputValue>);

export type StrictDateRangeRule =
  | (DateRuleBase<DateOperatorValues['between']> & ValueSource<[DateInputValue, DateInputValue]>)
  | (DateRuleBase<DateOperatorValues['notBetween']> &
      ValueSource<[DateInputValue, DateInputValue]>);

export type StrictDateDayRule =
  | (DateRuleBase<DateOperatorValues['dayIn']> & { value: string[]; path?: never })
  | (DateRuleBase<DateOperatorValues['dayNotIn']> & { value: string[]; path?: never });

export type StrictDateRule = StrictDateComparisonRule | StrictDateRangeRule | StrictDateDayRule;

type AggregateRuleBase<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  field: string;
  aggregate: { mode: AggregateMode; field?: string };
  condition?: StrictCondition<TRuleValue, TDateValue>;
  error?: string;
};

type AggregateSingleOperator =
  | OperatorValues['equals']
  | OperatorValues['notEquals']
  | OperatorValues['lessThan']
  | OperatorValues['lessThanEquals']
  | OperatorValues['greaterThan']
  | OperatorValues['greaterThanEquals'];

type AggregateRangeOperator = OperatorValues['between'] | OperatorValues['notBetween'];

export type StrictAggregateRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | (AggregateRuleBase<TRuleValue, TDateValue> & {
      operator: AggregateSingleOperator;
    } & ValueSource<number>)
  | (AggregateRuleBase<TRuleValue, TDateValue> & {
      operator: AggregateRangeOperator;
    } & ValueSource<[number, number]>);

// --- Windowing selector (v2.6.0) ---
// Ordered selection on array/aggregate rules. Pipeline: order → skip → take.
export type SortDir = 'asc' | 'desc';
export type OrderBy = { field: string; dir: SortDir }[];
export type WindowFields = {
  filter?: Condition;
  orderBy?: OrderBy;
  take?: number;
  skip?: number;
};

export type AggregateRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> = WindowFields & {
  field: string;
  aggregate: { mode: AggregateMode; field?: string };
  condition?: Condition<TRuleValue, TDateValue>;
  operator: Operator;
  value?: number | [number, number];
  path?: string;
  bind?: string;
  error?: string;
};

export type Rule<TValue = RuleValue> = {
  field: string;
  operator: Operator;
  value?: TValue;
  path?: string;
  bind?: string;
  error?: string;
  caseInsensitive?: boolean;
  // Declared kind both sides coerce to before comparing — never inferred from the
  // values. Stamp mechanically from a lens via stampCoercions().
  coerceType?: FieldKind;
};

export type ArrayRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> = WindowFields & {
  field?: string;
  arrayOperator: ArrayOperator;
  condition?: Condition<TRuleValue, TDateValue>;
  count?: number;
  error?: string;
};

export type DateRule<TValue = DateRuleValue> = {
  field: string;
  dateOperator: DateOperator;
  value?: TValue;
  path?: string;
  bind?: string;
  error?: string;
};

export type All<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  all: Condition<TRuleValue, TDateValue>[];
  error?: string;
};

export type Any<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  any: Condition<TRuleValue, TDateValue>[];
  error?: string;
};

export type IfThenElse<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  if: Condition<TRuleValue, TDateValue>;
  then: Condition<TRuleValue, TDateValue>;
  else?: Condition<TRuleValue, TDateValue>;
  error?: string;
};

export type Condition<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | Rule<TRuleValue>
  | AggregateRule<TRuleValue, TDateValue>
  | ArrayRule<TRuleValue, TDateValue>
  | DateRule<TDateValue>
  | All<TRuleValue, TDateValue>
  | Any<TRuleValue, TDateValue>
  | IfThenElse<TRuleValue, TDateValue>
  | boolean;

export type StrictAll<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  all: StrictCondition<TRuleValue, TDateValue>[];
  error?: string;
};

export type StrictAny<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  any: StrictCondition<TRuleValue, TDateValue>[];
  error?: string;
};

export type StrictIfThenElse<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  if: StrictCondition<TRuleValue, TDateValue>;
  then: StrictCondition<TRuleValue, TDateValue>;
  else?: StrictCondition<TRuleValue, TDateValue>;
  error?: string;
};

export type StrictCondition<TRuleValue = RuleValue, TDateValue = DateRuleValue> =
  | StrictRule<TRuleValue>
  | StrictAggregateRule<TRuleValue, TDateValue>
  | StrictArrayRule<TRuleValue, TDateValue>
  | StrictDateRule
  | StrictAll<TRuleValue, TDateValue>
  | StrictAny<TRuleValue, TDateValue>
  | StrictIfThenElse<TRuleValue, TDateValue>
  | boolean;
