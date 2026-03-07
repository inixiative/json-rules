export const Operator = {
  equals: 'equals',
  notEquals: 'notEquals',
  lessThan: 'lessThan',
  lessThanEquals: 'lessThanEquals',
  greaterThan: 'greaterThan',
  greaterThanEquals: 'greaterThanEquals',
  contains: 'contains',
  notContains: 'notContains',
  in: 'in',
  notIn: 'notIn',
  matches: 'matches',
  notMatches: 'notMatches',
  between: 'between',
  notBetween: 'notBetween',
  isEmpty: 'isEmpty',
  notEmpty: 'notEmpty',
  exists: 'exists',
  notExists: 'notExists',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
} as const;

export type Operator = (typeof Operator)[keyof typeof Operator];

export const ArrayOperator = {
  all: 'all',
  any: 'any',
  none: 'none',
  atLeast: 'atLeast',
  atMost: 'atMost',
  exactly: 'exactly',
  empty: 'empty',
  notEmpty: 'notEmpty',
} as const;

export type ArrayOperator = (typeof ArrayOperator)[keyof typeof ArrayOperator];

export const DateOperator = {
  before: 'before',
  after: 'after',
  onOrBefore: 'onOrBefore',
  onOrAfter: 'onOrAfter',
  between: 'between',
  notBetween: 'notBetween',
  dayIn: 'dayIn',
  dayNotIn: 'dayNotIn',
} as const;

export type DateOperator = (typeof DateOperator)[keyof typeof DateOperator];
