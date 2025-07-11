export enum Operator {
  equal = 'equal',
  notEqual = 'notEqual',
  lessThan = 'lessThan',
  lessThanEqual = 'lessThanEqual',
  greaterThan = 'greaterThan',
  greaterThanEqual = 'greaterThanEqual',
  contains = 'contains',
  notContains = 'notContains',
  in = 'in',
  notIn = 'notIn',
  match = 'match',
  notMatch = 'notMatch',
  between = 'between',
  notBetween = 'notBetween',
  isEmpty = 'isEmpty',
  notEmpty = 'notEmpty',
  exists = 'exists',
  notExists = 'notExists',
  startsWith = 'startsWith',
  endsWith = 'endsWith',
}

export enum ArrayOperator {
  all = 'all',
  any = 'any',
  none = 'none',
  atLeast = 'atLeast',
  atMost = 'atMost',
  exactly = 'exactly',
  empty = 'empty',
  notEmpty = 'notEmpty',
}

export enum DateOperator {
  before = 'before',
  after = 'after',
  onOrBefore = 'onOrBefore',
  onOrAfter = 'onOrAfter',
  between = 'between',
  notBetween = 'notBetween',
  dayIn = 'dayIn',  // e.g., ['monday', 'tuesday', 'friday']
  dayNotIn = 'dayNotIn',
}
