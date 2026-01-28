import {ArrayOperator, DateOperator, Operator} from "./operator.ts";

export type Rule = {
  field: string;
  operator: Operator;
  value?: any;
  path?: string;
  error?: string;
}

export type ArrayType = 'jsonb' | 'native';

export type ArrayRule = {
  field: string;
  arrayOperator: ArrayOperator;
  arrayType?: ArrayType;  // default: 'jsonb'
  condition?: Condition;
  count?: number;
  error?: string;
}

export type DateRule = {
  field: string;
  dateOperator: DateOperator;
  value?: any;
  path?: string;
  error?: string;
}

export type All = {
  all: Condition[];
  error?: string;
}

export type Any = {
  any: Condition[];
  error?: string;
}

export type IfThenElse = {
  if: Condition;
  then: Condition;
  else?: Condition;
  error?: string;
}

export type Condition =
  | Rule
  | ArrayRule
  | DateRule
  | All
  | Any
  | IfThenElse
  | boolean;
