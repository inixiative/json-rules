import { describe, expect, test } from 'bun:test';
import {
  type Condition,
  check,
  DateOperator,
  engineGlobals,
  toPrisma,
  toSql,
  validateRule,
} from '../index';

const now = new Date('2026-06-11T12:34:56Z');
const config = { now, timeZone: 'UTC' };
const row = {
  createdAt: new Date('2026-06-11T12:00:00Z'),
  updatedAt: new Date('2026-06-11T12:30:00Z'),
};

const hourly = <T>(fn: () => T): T => engineGlobals.with({ clock: { finestUnit: 'hour' } }, fn);

const created = (value: unknown, dateOperator: DateOperator = DateOperator.within): Condition =>
  ({ field: 'createdAt', dateOperator, value }) as Condition;

const finer: [string, Condition][] = [
  ['a rolling unit', created({ ago: { minutes: 30 } })],
  ['one unit of several', created({ ahead: { days: 1, seconds: 5 } })],
  ['a period', created({ this: 'minute' })],
  ['an edge', created({ start: { this: 'minute' } }, DateOperator.after)],
  ['a bare period on a point operator', created({ last: 'minute' }, DateOperator.before)],
  [
    'a range end',
    created(['2026-01-01T00:00:00.000Z', { ago: { minutes: 5 } }], DateOperator.between),
  ],
];

describe('clock.finestUnit: a rule reading the clock finer than the floor fails to evaluate', () => {
  for (const [name, rule] of finer) {
    test(`${name}: check, toPrisma and toSql throw`, () => {
      hourly(() => {
        expect(() => check(rule, row, config)).toThrow(/finer than.*clock\.finestUnit/);
        expect(() => toPrisma(rule, config)).toThrow(/finer than.*clock\.finestUnit/);
        expect(() => toSql(rule, config)).toThrow(/finer than.*clock\.finestUnit/);
      });
    });

    test(`${name}: validateRule reports it`, () => {
      const result = hourly(() => validateRule(rule));
      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain('clock_unit_below_floor');
    });

    test(`${name}: evaluates under the default floor`, () => {
      expect(() => check(rule, row, config)).not.toThrow();
      expect(validateRule(rule).ok).toBe(true);
    });
  }

  test('the floor unit and coarser evaluate', () => {
    hourly(() => {
      for (const rule of [created({ ago: { hours: 2 } }), created({ this: 'day' })]) {
        expect(check(rule, row, config)).toBe(true);
        expect(() => toPrisma(rule, config)).not.toThrow();
        expect(() => toSql(rule, config)).not.toThrow();
        expect(validateRule(rule).ok).toBe(true);
      }
    });
  });

  test('a column compare offset reads no clock and is never refused', () => {
    const rule = {
      field: 'updatedAt',
      dateOperator: DateOperator.after,
      path: 'createdAt',
      offset: { value: { ahead: { minutes: 10 } } },
    } as Condition;
    hourly(() => {
      expect(check(rule, row, config)).toBe(true);
      expect(() => toSql(rule, config)).not.toThrow();
      expect(validateRule(rule).ok).toBe(true);
    });
  });
});
