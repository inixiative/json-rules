import { describe, expect, test } from 'bun:test';
import {
  bindRule,
  type ClockUnit,
  type Condition,
  check,
  clockUnit,
  DateOperator,
  engineGlobals,
  type RelativeUnit,
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

  test('a row-to-row compare is held to the floor too: a finer offset fails, a coarser one runs', () => {
    const compare = (offset: unknown) =>
      ({
        field: 'updatedAt',
        dateOperator: DateOperator.after,
        path: 'createdAt',
        offset: { value: offset },
      }) as Condition;
    hourly(() => {
      const finer = compare({ ahead: { minutes: 10 } });
      expect(() => check(finer, row, config)).toThrow(/finer than/);
      expect(() => toSql(finer, config)).toThrow(/finer than/);
      expect(validateRule(finer).errors.map((e) => e.code)).toContain('clock_unit_below_floor');
      expect(() => clockUnit(finer)).toThrow(/finer than/);

      const coarser = compare({ ago: { hours: 1 } });
      expect(check(coarser, row, config)).toBe(true);
      expect(() => toSql(coarser, config)).not.toThrow();
      expect(validateRule(coarser).ok).toBe(true);
      expect(clockUnit(coarser)).toBeNull();
    });
  });
});

const rails = (
  rule: Condition,
  data: Record<string, unknown>,
  bindings?: Record<string, unknown>,
) => {
  const bound = bindings ? bindRule(rule, bindings as never) : rule;
  return [
    () => check(rule, data, { ...config, bindings: bindings as never }),
    () => toPrisma(bound, config),
    () => toSql(bound, config),
  ];
};

describe('clock.finestUnit: the rule as written decides, whatever the row or binding holds', () => {
  const pathMinutes = created({ ago: { minutes: { path: 'n' } } });

  test('an amount read from the row: check throws on every row, null included, and toSql throws', () => {
    hourly(() => {
      expect(() => check(pathMinutes, { ...row, n: 3 }, config)).toThrow(/finer than/);
      expect(() => check(pathMinutes, { ...row, n: null }, config)).toThrow(/finer than/);
      expect(() => toSql(pathMinutes, config)).toThrow(/finer than/);
      expect(validateRule(pathMinutes).ok).toBe(false);
    });
  });

  test('a bound amount: every rail throws, a null binding included', () => {
    const rule = created({ ago: { minutes: { bind: 'n' } } });
    hourly(() => {
      for (const n of [3, null])
        for (const run of rails(rule, row, { n })) expect(run).toThrow(/finer than/);
    });
  });

  test('a bound whole expression: every rail throws on a finer one', () => {
    const rule = { field: 'createdAt', dateOperator: DateOperator.before, bind: 'w' } as Condition;
    hourly(() => {
      for (const run of rails(rule, row, { w: { ago: { minutes: 30 } } }))
        expect(run).toThrow(/finer than/);
      for (const run of rails(rule, row, { w: { ago: { hours: 2 } } })) expect(run).not.toThrow();
    });
  });

  test('a bound null reads no clock: it behaves like null', () => {
    const rule = { field: 'createdAt', dateOperator: DateOperator.before, bind: 'w' } as Condition;
    hourly(() => {
      for (const run of rails(rule, row, { w: null })) expect(run).not.toThrow();
    });
  });
});

describe('clock.finestUnit: an offset is held to the floor', () => {
  const shifted = (offset: unknown): Condition =>
    ({
      field: 'createdAt',
      dateOperator: DateOperator.after,
      value: { ago: { days: 1 } },
      offset: { value: offset },
    }) as Condition;

  test('a finer offset fails on every rail, in validateRule and in clockUnit', () => {
    const rule = shifted({ ago: { minutes: 5 } });
    hourly(() => {
      for (const run of rails(rule, row)) expect(run).toThrow(/finer than/);
      expect(validateRule(rule).errors.map((e) => e.code)).toContain('clock_unit_below_floor');
      expect(() => clockUnit(rule)).toThrow(/finer than/);
    });
  });

  test('an offset at the floor or coarser evaluates, and clockUnit reads it', () => {
    const rule = shifted({ ahead: { hours: 3 } });
    hourly(() => {
      for (const run of rails(rule, row)) expect(run).not.toThrow();
      expect(validateRule(rule).ok).toBe(true);
      expect(clockUnit(rule)).toBe('hour');
    });
  });

  test('a finer offset on an absolute date fails too', () => {
    const rule = {
      field: 'createdAt',
      dateOperator: DateOperator.after,
      value: '2026-01-01T00:00:00.000Z',
      offset: { value: { ago: { minutes: 5 } } },
    } as Condition;
    hourly(() => {
      for (const run of rails(rule, row)) expect(run).toThrow(/finer than/);
      expect(validateRule(rule).errors.map((e) => e.code)).toContain('clock_unit_below_floor');
    });
  });
});

describe('clock.finestUnit takes a unit, singular or plural', () => {
  const minutes = created({ ago: { minutes: 30 } });

  test('a plural floor reads as its unit', () => {
    engineGlobals.with({ clock: { finestUnit: 'hours' } }, () => {
      expect(() => check(minutes, row, config)).toThrow(/finer than.*'hour'/);
      expect(check(created({ ago: { hours: 2 } }), row, config)).toBe(true);
    });
  });

  test('anything else fails loudly instead of switching the floor off', () => {
    engineGlobals.with({ clock: { finestUnit: 'fortnight' as never } }, () => {
      expect(() => check(minutes, row, config)).toThrow(/clock\.finestUnit/);
      expect(() => validateRule(minutes)).toThrow(/clock\.finestUnit/);
    });
  });

  test('each path takes only its own values', () => {
    const typeOnly = () => {
      engineGlobals.set('clock.finestUnit', 'hour');
      engineGlobals.set('clock.finestUnit', 'hours');
      engineGlobals.set('sql.dialect', 'mysql');
      // @ts-expect-error not a clock unit
      engineGlobals.set('clock.finestUnit', 'fortnight');
      // @ts-expect-error a boolean path
      engineGlobals.set('string.caseInsensitive', 'yes');
      // @ts-expect-error not a path
      engineGlobals.set('clock.finest', 'hour');
      const floor: ClockUnit | RelativeUnit = engineGlobals.get('clock.finestUnit');
      // @ts-expect-error get returns the path's type
      const dialect: number = engineGlobals.get('sql.dialect');
      return [floor, dialect];
    };
    expect(typeof typeOnly).toBe('function');
  });
});
