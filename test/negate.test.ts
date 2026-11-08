import { describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { check } from '../index';
import { negate, settleIn } from '../src/negate';

// negate(c) holds exactly where check(c) doesn't — over NULLs, empty strings, missing fields,
// empty arrays, every operator family and the logical nodes.

// `m` and `r` are operands read per row: a number, a range, or nothing.
const rows = [
  {
    n: 5,
    s: 'abc',
    d: '2026-10-05T00:00:00Z',
    tags: [{ t: 'a' }, { t: 'b' }],
    nums: [1, 2],
    m: 4,
    r: [1, 4],
  },
  { n: 10, s: '', d: '2026-10-07T00:00:00Z', tags: [{ t: 'a' }], nums: [], m: null, r: [null, 3] },
  { n: null, s: null, d: null, tags: [], nums: [5], m: 5, r: null },
  { tags: [{ t: 'c', n: 2 }], nums: [3, 4], r: [2, 9] },
  { n: 1, tags: [{ t: 'a', n: null }], nums: [null], m: 1 },
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
  // FEAT-007: an average over no values is NULL; every operator's negation keeps exactly the rows
  // the rule drops, the empty and the absent `nums` included.
  ...['equals', 'notEquals', 'lessThan', 'lessThanEquals', 'greaterThan', 'greaterThanEquals'].map(
    (operator): [string, Condition] => [
      `aggregate avg ${operator}`,
      rule({ field: 'nums', aggregate: { mode: 'avg' }, operator, value: 3 }),
    ],
  ),
  [
    'aggregate avg notBetween',
    rule({ field: 'nums', aggregate: { mode: 'avg' }, operator: 'notBetween', value: [1, 4] }),
  ],
  [
    'aggregate avg over rows a condition empties',
    rule({
      field: 'tags',
      aggregate: { mode: 'avg', field: 'n' },
      condition: { field: 't', operator: 'equals', value: 'a' },
      operator: 'greaterThan',
      value: 0,
    }),
  ],
  ['aggregate avg exists', rule({ field: 'nums', aggregate: { mode: 'avg' }, operator: 'exists' })],
  [
    'aggregate avg notExists',
    rule({ field: 'nums', aggregate: { mode: 'avg' }, operator: 'notExists' }),
  ],
  ['aggregate sum exists', rule({ field: 'nums', aggregate: { mode: 'sum' }, operator: 'exists' })],
  [
    'aggregate avg negated with nothing to compare against',
    rule({ field: 'nums', aggregate: { mode: 'avg' }, operator: 'notBetween', value: [null, 3] }),
  ],
  [
    'aggregate avg with nothing to compare against',
    rule({ field: 'nums', aggregate: { mode: 'avg' }, operator: 'between', value: [null, 3] }),
  ],
  [
    'aggregate sum negated with nothing to compare against',
    rule({ field: 'nums', aggregate: { mode: 'sum' }, operator: 'notBetween', value: [null, 3] }),
  ],
];

// Operands read from a bind or the row: an operand that reads nothing settles as a null literal
// does (negate reads them through check()'s own sources, settleIn).
const missing = { bind: 'q', bindOptional: true };
const sourced: [string, Condition][] = [
  ...[
    ['lessThan', 'm'],
    ['notEquals', 'm'],
    ['notBetween', 'r'],
    ['between', 'r'],
    ['notIn', 'r'],
  ].flatMap(([operator, path]): [string, Condition][] => [
    [`${operator} a path`, rule({ field: 'n', operator, path })],
    [
      `aggregate avg ${operator} a path`,
      rule({ field: 'nums', aggregate: { mode: 'avg' }, operator, path }),
    ],
  ]),
  ...['notBetween', 'between', 'lessThan', 'notEquals', 'equals'].flatMap(
    (operator): [string, Condition][] => [
      [`${operator} a missing bind`, rule({ field: 'n', operator, ...missing })],
      [
        `aggregate avg ${operator} a missing bind`,
        rule({ field: 'nums', aggregate: { mode: 'avg' }, operator, ...missing }),
      ],
      [
        `aggregate sum ${operator} a missing bind`,
        rule({ field: 'nums', aggregate: { mode: 'sum' }, operator, ...missing }),
      ],
    ],
  ),
  ['a bound range', rule({ field: 'n', operator: 'notBetween', bind: 'range' })],
  [
    'an offset read from the row',
    rule({ field: 'n', operator: 'lessThan', value: 3, offset: { path: 'm' } }),
  ],
  ['a date before a missing bind', rule({ field: 'd', dateOperator: 'notBefore', ...missing })],
  [
    'all over items compared with the row',
    rule({
      field: 'tags',
      arrayOperator: 'all',
      condition: { field: 'n', operator: 'notEquals', path: '$$.m' },
    }),
  ],
  [
    'all over items compared with themselves',
    rule({
      field: 'tags',
      arrayOperator: 'all',
      condition: { field: 'n', operator: 'notBetween', path: '$.r' },
    }),
  ],
  // A date amount that reads nothing places no date: the rule is false, its negation keeps NULL.
  ...['within', 'notWithin'].map((dateOperator): [string, Condition] => [
    `${dateOperator} an amount that reads nothing`,
    rule({ field: 'd', dateOperator, value: { ago: { days: missing } } }),
  ]),
  [
    'a date amount read from the row',
    rule({ field: 'd', dateOperator: 'within', value: { ago: { days: { path: 'm' } } } }),
  ],
  [
    'a date offset whose amount reads nothing',
    rule({
      field: 'd',
      dateOperator: 'notBefore',
      value: now,
      offset: { value: { ago: { days: missing } } },
    }),
  ],
  [
    'an average over a window',
    rule({
      field: 'tags',
      aggregate: { mode: 'avg', field: 'n' },
      orderBy: [{ field: 't', dir: 'desc' }],
      take: 1,
      operator: 'lessThan',
      value: 3,
    }),
  ],
];
const bindings = { range: [4, 6] };

const logical: [string, Condition][] = [
  ['all', { all: [leaves[0][1], leaves[9][1]] }],
  ['any', { any: [leaves[2][1], leaves[12][1]] }],
  ['if/then', { if: leaves[0][1], then: leaves[9][1] }],
  ['if/then/else', { if: leaves[2][1], then: leaves[9][1], else: leaves[13][1] }],
  ['true', true],
  ['false', false],
];

describe('negate is the exact complement under check()', () => {
  for (const [name, condition] of [...leaves, ...sourced, ...logical])
    test(name, () => {
      for (const row of rows) {
        const negated = negate(condition, settleIn({ bindings, scopes: [row] }));
        expect([name, row, check(negated, row, { now, bindings }) === true]).toEqual([
          name,
          row,
          check(condition, row, { now, bindings }) !== true,
        ]);
      }
    });
});
