import { describe, expect, test } from 'bun:test';
import { type RuleTarget, validateRule } from '../index';

// One case per rejection validateRule can make, and what a well-formed sibling looks like.

const cond = { field: 'x', operator: 'exists' };
const cases: [string, unknown, string[], RuleTarget?][] = [
  ['a non-object condition', 42, ['invalid_condition']],
  ['an if without then', { if: cond }, ['invalid_condition']],
  ['all that is not a list', { all: 'x' }, ['logical_array_required']],
  ['a field rule with no field', { operator: 'equals', value: 1 }, ['field_required']],
  ['contains a number', { field: 'a', operator: 'contains', value: 3 }, ['invalid_string_value']],
  [
    'lessThan an object',
    { field: 'a', operator: 'lessThan', value: {} },
    ['invalid_ordered_value'],
  ],
  ['in a scalar', { field: 'a', operator: 'in', value: 3 }, ['invalid_membership_value']],
  ['matches a number', { field: 'a', operator: 'matches', value: 3 }, ['invalid_pattern_value']],
  [
    'an aggregate with no field',
    { aggregate: { mode: 'sum' }, operator: 'equals', value: 1 },
    ['field_required'],
  ],
  [
    'an aggregate that is not an object',
    { field: 'a', aggregate: 5, operator: 'equals', value: 1 },
    ['invalid_aggregate'],
  ],
  [
    'an aggregate field that is not a string',
    { field: 'a', aggregate: { mode: 'sum', field: 3 }, operator: 'equals', value: 1 },
    ['invalid_aggregate_field'],
  ],
  [
    'an aggregate compared to a string',
    { field: 'a', aggregate: { mode: 'sum' }, operator: 'equals', value: 'x' },
    ['invalid_aggregate_value'],
  ],
  [
    'an aggregate with an offset',
    { field: 'a', aggregate: { mode: 'sum' }, operator: 'equals', value: 1, offset: { value: 1 } },
    ['unexpected_offset'],
  ],
  [
    'all on toSql',
    { field: 'a', arrayOperator: 'all', condition: cond },
    ['unsupported_sql_array_operator'],
    'toSql',
  ],
  ['an unknown array operator', { field: 'a', arrayOperator: 'bogus' }, ['invalid_array_operator']],
  [
    'empty with a condition',
    { field: 'a', arrayOperator: 'empty', condition: cond },
    ['unexpected_condition'],
  ],
  ['empty with a count', { field: 'a', arrayOperator: 'empty', count: 1 }, ['unexpected_count']],
  [
    'any with a count',
    { field: 'a', arrayOperator: 'any', condition: cond, count: 1 },
    ['unexpected_count'],
  ],
  ['any without a condition', { field: 'a', arrayOperator: 'any' }, ['missing_condition']],
  [
    'atLeast without a condition',
    { field: 'a', arrayOperator: 'atLeast', count: 1 },
    ['missing_condition'],
  ],
  [
    'atLeast a negative count',
    { field: 'a', arrayOperator: 'atLeast', condition: cond, count: -1 },
    ['invalid_count'],
  ],
  [
    'atLeast a fractional count',
    { field: 'a', arrayOperator: 'atLeast', condition: cond, count: 1.5 },
    ['invalid_count'],
  ],
  [
    'a date rule with no field',
    { dateOperator: 'before', value: '2024-01-01' },
    ['field_required'],
  ],
  [
    'an unknown date operator',
    { field: 'a', dateOperator: 'bogus', value: '2024-01-01' },
    ['invalid_date_operator'],
  ],
  [
    'dayIn on toPrisma',
    { field: 'a', dateOperator: 'dayIn', value: ['monday'] },
    ['unsupported_prisma_date_operator'],
    'toPrisma',
  ],
  [
    'a date range with a bad end',
    { field: 'a', dateOperator: 'between', value: ['2024-01-01', 'nope'] },
    ['invalid_date_value'],
  ],
  [
    'a date range of one',
    { field: 'a', dateOperator: 'between', value: ['2024-01-01'] },
    ['invalid_date_range'],
  ],
  [
    'rolling units with none',
    { field: 'a', dateOperator: 'before', value: { ago: {} } },
    ['invalid_relative_units'],
  ],
  [
    'an unknown period',
    { field: 'a', dateOperator: 'within', value: { this: 'decade' } },
    ['invalid_period_unit'],
  ],
  ['isEmpty with a path', { field: 'a', operator: 'isEmpty', path: 'x' }, ['unexpected_path']],
  [
    'an orderBy field that is not a string',
    { field: 'a', arrayOperator: 'any', condition: cond, orderBy: [{ field: 1, dir: 'asc' }] },
    ['invalid_order_by'],
  ],
];

describe('validateRule — each rejection', () => {
  for (const [name, rule, codes, target] of cases)
    test(name, () => {
      expect(validateRule(rule, target ? { target } : {}).errors.map((e) => e.code)).toEqual(codes);
    });
});

describe('validateRule — well-formed siblings', () => {
  test.each([
    ['a date range', { field: 'a', dateOperator: 'between', value: ['2024-01-01', '2024-02-01'] }],
    [
      'a date range of expressions',
      {
        field: 'a',
        dateOperator: 'notBetween',
        value: [{ start: { this: 'month' } }, { end: { this: 'month' } }],
      },
    ],
    ['false on toPrisma', false],
    ['atLeast zero', { field: 'a', arrayOperator: 'atLeast', condition: cond, count: 0 }],
  ])('%s', (_, rule) => {
    expect(validateRule(rule, { target: 'toPrisma' }).errors).toEqual([]);
  });
});
