import type { ArrayOperator, DateOperator, Operator } from './operator.ts';

export type RuleScalar = string | number | boolean | null | undefined;

export type RuleValue = RuleScalar | Date | RegExp | RuleValue[] | { [key: string]: RuleValue };

export type DateInputValue = string | number | Date;
export type DateRuleValue = DateInputValue | [DateInputValue, DateInputValue] | string[];

export type Rule<TValue = RuleValue> = {
  field: string;
  operator: Operator;
  value?: TValue;
  path?: string;
  error?: string;
};

export type ArrayType = 'jsonb' | 'native';

export type ArrayRule<TRuleValue = RuleValue, TDateValue = DateRuleValue> = {
  field: string;
  arrayOperator: ArrayOperator;
  arrayType?: ArrayType; // default: 'jsonb'
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
