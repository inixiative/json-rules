import type { ArrayOperator, DateOperator, Operator } from './operator.ts';

type OperatorValues = typeof import('./operator.ts').Operator;
type ArrayOperatorValues = typeof import('./operator.ts').ArrayOperator;
type DateOperatorValues = typeof import('./operator.ts').DateOperator;

export type RuleScalar = string | number | boolean | null | undefined;

export type RuleValue = RuleScalar | Date | RegExp | RuleValue[] | { [key: string]: RuleValue };
export type OrderedRuleValue = string | number | Date;

export type DateInputValue = string | number | Date;
export type DateRuleValue = DateInputValue | [DateInputValue, DateInputValue] | string[];

type ValueSource<TValue> = { value: TValue; path?: never } | { path: string; value?: never };
type NoValueSource = { value?: never; path?: never };
type RuleBase<TOperator extends Operator> = {
  field: string;
  operator: TOperator;
  error?: string;
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

export type ArrayType = 'jsonb' | 'native';

type ArrayRuleBase<TOperator extends ArrayOperator> = {
  field: string;
  arrayOperator: TOperator;
  arrayType?: ArrayType;
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

export type Rule<TValue = RuleValue> = {
  field: string;
  operator: Operator;
  value?: TValue;
  path?: string;
  error?: string;
};

export type ArrayRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  field: string;
  arrayOperator: ArrayOperator;
  arrayType?: ArrayType;
  condition?: Condition<TRuleValue, TDateValue>;
  count?: number;
  error?: string;
};

export type DateRule<TValue = DateRuleValue> = {
  field: string;
  dateOperator: DateOperator;
  value?: TValue;
  path?: string;
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
  | StrictArrayRule<TRuleValue, TDateValue>
  | StrictDateRule
  | StrictAll<TRuleValue, TDateValue>
  | StrictAny<TRuleValue, TDateValue>
  | StrictIfThenElse<TRuleValue, TDateValue>
  | boolean;
