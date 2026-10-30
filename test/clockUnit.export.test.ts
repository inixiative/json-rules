import { describe, expect, test } from 'bun:test';
import {
  ArrayOperator,
  CLOCK_UNITS,
  type Condition,
  clockUnit,
  DateOperator,
  engineGlobals,
  Operator,
} from '../index';

const created = (value: unknown, dateOperator: DateOperator = DateOperator.within): Condition =>
  ({ field: 'createdAt', dateOperator, value }) as Condition;

describe('clockUnit: the finest clock unit a rule reads', () => {
  test('a rolling window reads each unit it names, the finest wins', () => {
    expect(clockUnit(created({ ago: { hours: 2 } }))).toBe('hour');
    expect(clockUnit(created({ ahead: { seconds: 90 } }))).toBe('second');
    expect(clockUnit(created({ ago: { years: 1, days: 3 } }))).toBe('day');
    expect(clockUnit(created({ ago: { quarters: 1 } }))).toBe('quarter');
  });

  test('a bound amount still reads the clock at its unit', () => {
    expect(clockUnit(created({ ago: { weeks: { bind: 'n' } } }))).toBe('week');
  });

  test('a period reads its unit; isoWeek turns over weekly', () => {
    expect(clockUnit(created({ this: 'month' }))).toBe('month');
    expect(clockUnit(created({ last: 'year' }))).toBe('year');
    expect(clockUnit(created({ next: 'isoWeek' }))).toBe('week');
    expect(clockUnit(created({ this: 'minute' }))).toBe('minute');
  });

  test('an edge reads its period unit', () => {
    expect(clockUnit(created({ start: { this: 'quarter' } }, DateOperator.after))).toBe('quarter');
    expect(clockUnit(created({ end: { last: 'day' } }, DateOperator.before))).toBe('day');
  });

  test('a range reads both ends', () => {
    expect(
      clockUnit(
        created(['2026-01-01T00:00:00.000Z', { end: { this: 'day' } }], DateOperator.between),
      ),
    ).toBe('day');
  });

  test('null when the rule reads no clock', () => {
    expect(clockUnit(created('2026-01-01T00:00:00.000Z', DateOperator.after))).toBeNull();
    expect(clockUnit(created(['2026-01-01', '2026-02-01'], DateOperator.between))).toBeNull();
    expect(
      clockUnit({
        field: 'updatedAt',
        dateOperator: DateOperator.after,
        path: 'createdAt',
        offset: { value: { ago: { days: 1 } } },
      } as Condition),
    ).toBeNull();
    expect(clockUnit(created(['monday'], DateOperator.dayIn))).toBeNull();
    expect(clockUnit({ field: 'tier', operator: Operator.equals, value: 'year' })).toBeNull();
    expect(clockUnit(true)).toBeNull();
  });

  test('reads every branch: all / any, if / then / else, a relation condition and filter', () => {
    expect(
      clockUnit({
        all: [
          { field: 'email', operator: Operator.notEmpty },
          {
            any: [
              { field: 'tier', operator: Operator.equals, value: 'gold' },
              {
                field: 'stats',
                arrayOperator: ArrayOperator.atLeast,
                count: 1,
                condition: { all: [created({ last: 'month' })] },
              },
            ],
          },
        ],
      } as Condition),
    ).toBe('month');
    expect(
      clockUnit({
        field: 'stats',
        operator: Operator.greaterThan,
        value: 3,
        aggregate: { mode: 'sum', field: 'points' },
        filter: created({ ago: { hours: 6 } }),
      } as Condition),
    ).toBe('hour');
    expect(
      clockUnit({
        if: { field: 'email', operator: Operator.notEmpty },
        then: created({ this: 'year' }),
        else: created({ ago: { days: 7 } }),
      } as Condition),
    ).toBe('day');
  });

  test('CLOCK_UNITS orders finest first', () => {
    expect(CLOCK_UNITS[0]).toBe('second');
    expect(CLOCK_UNITS.at(-1)).toBe('year');
  });
});

describe('clockUnit under clock.finestUnit: a finer unit fails', () => {
  const hourly = <T>(fn: () => T): T => engineGlobals.with({ clock: { finestUnit: 'hour' } }, fn);

  test('the default floor is second: every unit comes back as it is', () => {
    expect(engineGlobals.get('clock.finestUnit')).toBe('second');
    expect(clockUnit(created({ ago: { minutes: 30 } }))).toBe('minute');
    expect(clockUnit(created({ this: 'second' }))).toBe('second');
  });

  test('an hour floor refuses minutes and seconds anywhere in the tree', () => {
    expect(() => hourly(() => clockUnit(created({ ago: { minutes: 30 } })))).toThrow(
      /minute.*finer than.*clock\.finestUnit.*hour/,
    );
    expect(() => hourly(() => clockUnit(created({ this: 'minute' })))).toThrow(/finestUnit/);
    expect(() => hourly(() => clockUnit(created({ ahead: { seconds: 90, days: 2 } })))).toThrow(
      /second/,
    );
    expect(() =>
      hourly(() =>
        clockUnit({
          all: [
            created({ this: 'day' }),
            created({ end: { this: 'minute' } }, DateOperator.before),
          ],
        } as Condition),
      ),
    ).toThrow(/finestUnit/);
  });

  test('an hour floor leaves the floor and coarser units alone', () => {
    expect(hourly(() => clockUnit(created({ ago: { hours: 2 } })))).toBe('hour');
    expect(hourly(() => clockUnit(created({ this: 'day' })))).toBe('day');
    expect(hourly(() => clockUnit(created({ last: 'quarter' })))).toBe('quarter');
  });

  test('a rule that reads no clock is never refused', () => {
    expect(
      hourly(() => clockUnit(created('2026-01-01T00:00:00.000Z', DateOperator.after))),
    ).toBeNull();
  });
});
