import { describe, expect, test } from 'bun:test';
import { check, toPrisma, toSql } from '../index';

// An operand of the wrong form throws on every rail, as validateRule rejects it — a rail never
// reads it as something else.

const NOW = new Date('2026-10-06T12:00:00Z');
const rails = (rule: object) => [
  () => check(rule as never, { tags: 'a', createdAt: NOW }, { now: NOW }),
  () => toSql(rule as never, { now: NOW }),
  () => toPrisma(rule as never, { now: NOW }),
];

describe('malformed operands throw on every rail', () => {
  test('in with a scalar', () => {
    for (const run of rails({ field: 'tags', operator: 'in', value: 'a' }))
      expect(run).toThrow('requires a list');
  });

  test('an unknown period', () => {
    for (const run of rails({
      field: 'createdAt',
      dateOperator: 'within',
      value: { this: 'fortnight' },
    }))
      expect(run).toThrow("Unknown period unit 'fortnight'");
  });
});
