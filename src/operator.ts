export enum Operator {
  equals = 'equals',
  notEquals = 'notEquals',
  lessThan = 'lessThan',
  lessThanEquals = 'lessThanEquals',
  greaterThan = 'greaterThan',
  greaterThanEquals = 'greaterThanEquals',
  contains = 'contains',
  notContains = 'notContains',
  in = 'in',
  notIn = 'notIn',
  matches = 'matches',
  notMatches = 'notMatches',
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
