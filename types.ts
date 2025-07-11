import {ArrayOperator, Operator} from "./operator.ts";

export type Rule = {
  field: string;
  operator: Operator;
  value?: any;
  path?: string;
  error?: string;
}

export type ArrayRule = {
  arrayOperator: ArrayOperator;
}

export type All = {
  all: Condition[];
  error?: string;
}

export type Any = {
  any: Condition[];
  error?: string;
}

export type Condition =
  | Rule
  | ArrayRule
  | All
  | Any
  | boolean;
