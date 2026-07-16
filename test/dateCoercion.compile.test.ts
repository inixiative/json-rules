import { describe, expect, test } from 'bun:test';
import { check, toPrisma, toSql, validateRule } from '../index';
import { DateOperator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        createdAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};

const getWhere = (result: ReturnType<typeof toPrisma>): Record<string, unknown> => {
  const last = result.steps[result.steps.length - 1];
  return (last && 'where' in last ? last.where : {}) as Record<string, unknown>;
};

// check() anchors a naive date string at midnight in the resolved zone (default UTC).
// The compilers must emit that same instant — a raw 'YYYY-MM-DD' string in a Prisma
// where is rejected by Prisma and, worse, would carry different zone semantics than
// check(), breaking the fetch-then-recheck contract.
describe('toPrisma — literal date values compile to the instant check() compares against', () => {
  test('date-only literal anchors at UTC midnight by default', () => {
    const result = toPrisma(
      { field: 'createdAt', dateOperator: DateOperator.after, value: '2026-01-01' },
      {
        map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
        mapName: 'app',
        model: 'User',
      },
    );
    expect(getWhere(result)).toEqual({ createdAt: { gt: new Date('2026-01-01T00:00:00.000Z') } });
  });

  test('date-only literal anchors in the configured timezone', () => {
    const result = toPrisma(
      { field: 'createdAt', dateOperator: DateOperator.after, value: '2026-01-01' },
      {
        map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
        mapName: 'app',
        model: 'User',
        timeZone: 'America/New_York',
      },
    );
    expect(getWhere(result)).toEqual({ createdAt: { gt: new Date('2026-01-01T05:00:00.000Z') } });
  });

  test('an explicit-zone string is an absolute instant, never re-anchored', () => {
    const result = toPrisma(
      { field: 'createdAt', dateOperator: DateOperator.onOrBefore, value: '2026-01-01T10:00:00Z' },
      {
        map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
        mapName: 'app',
        model: 'User',
        timeZone: 'America/New_York',
      },
    );
    expect(getWhere(result)).toEqual({ createdAt: { lte: new Date('2026-01-01T10:00:00.000Z') } });
  });

  test('Date objects and epoch numbers pass through as their instant', () => {
    const instant = new Date('2026-03-05T12:00:00.000Z');
    const byDate = toPrisma(
      { field: 'createdAt', dateOperator: DateOperator.before, value: instant },
      {
        map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
        mapName: 'app',
        model: 'User',
      },
    );
    expect(getWhere(byDate)).toEqual({ createdAt: { lt: instant } });

    const byEpoch = toPrisma(
      { field: 'createdAt', dateOperator: DateOperator.before, value: instant.getTime() },
      {
        map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
        mapName: 'app',
        model: 'User',
      },
    );
    expect(getWhere(byEpoch)).toEqual({ createdAt: { lt: instant } });
  });

  test('between anchors both naive elements in the configured timezone', () => {
    const result = toPrisma(
      {
        field: 'createdAt',
        dateOperator: DateOperator.between,
        value: ['2026-02-01', '2026-01-01'],
      },
      {
        map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
        mapName: 'app',
        model: 'User',
        timeZone: 'America/New_York',
      },
    );
    expect(getWhere(result)).toEqual({
      createdAt: {
        gte: new Date('2026-01-01T05:00:00.000Z'),
        lte: new Date('2026-02-01T05:00:00.000Z'),
      },
    });
  });

  test('an unparseable literal fails the compile loudly', () => {
    expect(() =>
      toPrisma(
        { field: 'createdAt', dateOperator: DateOperator.after, value: 'not-a-date' },
        {
          map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
          mapName: 'app',
          model: 'User',
        },
      ),
    ).toThrow(/not-a-date/);
  });

  test('parity: the compiled instant is the boundary check() uses', () => {
    const rule = {
      field: 'createdAt',
      dateOperator: DateOperator.after,
      value: '2026-01-01',
    } as const;
    const config = { timeZone: 'America/New_York' };
    const boundary = new Date('2026-01-01T05:00:00.000Z');

    const result = toPrisma(rule, {
      map: { maps: { app: map }, mapName: 'app', model: 'User' } as never,
      mapName: 'app',
      model: 'User',
      ...config,
    });
    expect(getWhere(result)).toEqual({ createdAt: { gt: boundary } });

    // A row just before the boundary fails both; just after passes both.
    expect(check(rule, { createdAt: '2026-01-01T04:59:59Z' }, config)).not.toBe(true);
    expect(check(rule, { createdAt: '2026-01-01T05:00:01Z' }, config)).toBe(true);
  });
});

describe('toSql — literal date values compile to the anchored instant', () => {
  test('date-only literal param is the timezone-anchored Date', () => {
    const { sql, params } = toSql(
      { field: 'createdAt', dateOperator: DateOperator.after, value: '2026-01-01' },
      { map, model: 'User', alias: 't0', timeZone: 'America/New_York' },
    );
    expect(sql).toContain('>');
    expect(params).toEqual([new Date('2026-01-01T05:00:00.000Z')]);
  });
});

describe('validateRule — date values must parse', () => {
  test('rejects an unparseable date string', () => {
    const result = validateRule({
      field: 'createdAt',
      dateOperator: DateOperator.after,
      value: 'garbage',
    });
    expect(result.ok).toBe(false);
  });

  test('rejects a between pair containing an unparseable element', () => {
    const result = validateRule({
      field: 'createdAt',
      dateOperator: DateOperator.between,
      value: ['2026-01-01', 'garbage'],
    });
    expect(result.ok).toBe(false);
  });

  test('accepts date-only, full ISO, epoch, and Date values', () => {
    for (const value of ['2026-01-01', '2026-01-01T10:00:00Z', 1767225600000, new Date()]) {
      const result = validateRule({ field: 'createdAt', dateOperator: DateOperator.after, value });
      expect(result.ok).toBe(true);
    }
  });
});
