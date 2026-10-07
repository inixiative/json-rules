import { describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { check } from '../index';
import { negate, settleLiteral } from '../src/negate';

// negate(c) holds exactly where check(c) doesn't — over NULLs, empty strings, missing fields,
// empty arrays, every operator family and the logical nodes.

const rows = [
  { n: 5, s: 'abc', d: '2026-10-05T00:00:00Z', tags: [{ t: 'a' }, { t: 'b' }], nums: [1, 2] },
  { n: 10, s: '', d: '2026-10-07T00:00:00Z', tags: [{ t: 'a' }], nums: [] },
  { n: null, s: null, d: null, tags: [], nums: [5] },
  { tags: [{ t: 'c' }], nums: [3, 4] },
];
const rule = (r: object): Condition => r as never;
const now = '2026-10-06T00:00:00Z';

const leaves: [string, Condition][] = [
  ...['equals', 'notEquals', 'lessThan', 'lessThanEquals', 'greaterThan', 'greaterThanEquals'].map(
    (operator): [string, Condition] => [operator, rule({ field: 'n', operator, value: 5 })],
  ),
  ['equals null', rule({ field: 'n', operator: 'equals', value: null })],
  ['in', rule({ field: 'n', operator: 'in', value: [5, null] })],
  ['notIn', rule({ field: 'n', operator: 'notIn', value: [10] })],
  ['contains', rule({ field: 's', operator: 'contains', value: 'b' })],
  ['notContains', rule({ field: 's', operator: 'notContains', value: 'b' })],
  ['matches', rule({ field: 's', operator: 'matches', value: '^a' })],
  ['between', rule({ field: 'n', operator: 'between', value: [4, 6] })],
  ['notBetween', rule({ field: 'n', operator: 'notBetween', value: [4, 6] })],
  ['isEmpty', rule({ field: 's', operator: 'isEmpty' })],
  ['exists', rule({ field: 'n', operator: 'exists' })],
  ['an offset', rule({ field: 'n', operator: 'lessThan', value: 4, offset: { value: 2 } })],
  [
    'an offset reading nothing',
    rule({ field: 'n', operator: 'lessThan', value: null, offset: { value: 2 } }),
  ],
  [
    'a negated offset reading nothing',
    rule({ field: 'n', operator: 'notEquals', value: null, offset: { value: 2 } }),
  ],
  ...['before', 'after', 'onOrBefore', 'onOrAfter', 'notBefore', 'notAfter'].map(
    (dateOperator): [string, Condition] => [
      dateOperator,
      rule({ field: 'd', dateOperator, value: now }),
    ],
  ),
  ['within', rule({ field: 'd', dateOperator: 'within', value: { ago: { days: 2 } } })],
  [
    'date between',
    rule({ field: 'd', dateOperator: 'between', value: ['2026-10-01', '2026-10-06'] }),
  ],
  ['dayIn', rule({ field: 'd', dateOperator: 'dayIn', value: ['monday'] })],
  ...['any', 'all', 'none'].map((arrayOperator): [string, Condition] => [
    `array ${arrayOperator}`,
    rule({
      field: 'tags',
      arrayOperator,
      condition: { field: 't', operator: 'equals', value: 'a' },
    }),
  ]),
  ...(['atLeast', 'atMost', 'exactly'] as const).flatMap((arrayOperator) =>
    [0, 1, 2].map((count): [string, Condition] => [
      `array ${arrayOperator} ${count}`,
      rule({
        field: 'tags',
        arrayOperator,
        count,
        condition: { field: 't', operator: 'equals', value: 'a' },
      }),
    ]),
  ),
  ['array empty', rule({ field: 'tags', arrayOperator: 'empty' })],
  [
    'aggregate sum',
    rule({ field: 'nums', aggregate: { mode: 'sum' }, operator: 'greaterThan', value: 3 }),
  ],
  [
    'aggregate between',
    rule({ field: 'nums', aggregate: { mode: 'avg' }, operator: 'between', value: [1, 4] }),
  ],
];

const logical: [string, Condition][] = [
  ['all', { all: [leaves[0][1], leaves[9][1]] }],
  ['any', { any: [leaves[2][1], leaves[12][1]] }],
  ['if/then', { if: leaves[0][1], then: leaves[9][1] }],
  ['if/then/else', { if: leaves[2][1], then: leaves[9][1], else: leaves[13][1] }],
  ['true', true],
  ['false', false],
];

describe('negate is the exact complement under check()', () => {
  for (const [name, condition] of [...leaves, ...logical])
    test(name, () => {
      const negated = negate(condition, settleLiteral);
      for (const row of rows)
        expect([name, row, check(negated, row, { now }) === true]).toEqual([
          name,
          row,
          check(condition, row, { now }) !== true,
        ]);
    });
});
