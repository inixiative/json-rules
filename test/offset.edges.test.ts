import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { check, toPrisma, toSql, validateRule } from '../index';
import { validateRuleInLens } from '../src/lens/checkRule';
import { createLens } from '../src/lens/createLens';
import { getWhere } from './fixtures/helpers';

// Edges where the rails could part: amounts that aren't whole or are negative, a range with one
// missing end, row-computed range ends, bigint / Decimal / float bases, and a zone with DST.

const rule = (r: object): Condition => r as never;
const NOW = new Date('2026-10-06T00:00:00Z');

type Row = Record<string, unknown> & { id: number };

const table = (ddl: string, rows: Row[], columns: string[]) => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`SET TIME ZONE 'UTC'`);
    await db.exec(ddl);
    for (const r of rows) {
      const params = columns.map((c) => r[c] ?? null);
      await db.query(
        `INSERT INTO t VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        params,
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });
  return async (
    condition: Condition,
    expected: number[],
    opts: { context?: Record<string, unknown>; timeZone?: string } = {},
  ) => {
    const inMemory = rows
      .filter((r) => check(condition, r, { now: NOW, ...opts } as never) === true)
      .map((r) => r.id);
    const { sql, params } = toSql(condition, { now: NOW, ...opts } as never);
    const viaSql = (
      await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
    ).rows.map((r) => r.id);
    expect(inMemory).toEqual(expected);
    expect(viaSql).toEqual(expected);
  };
};

describe('magnitudes read from data: calendar units are whole, every unit non-negative', () => {
  const rows: Row[] = [
    { id: 1, ts: new Date('2026-09-20T00:00:00Z'), anchor: new Date('2026-10-01T00:00:00Z'), n: 7 },
    {
      id: 2,
      ts: new Date('2026-09-20T00:00:00Z'),
      anchor: new Date('2026-10-01T00:00:00Z'),
      n: 0.5,
    },
    {
      id: 3,
      ts: new Date('2026-09-20T00:00:00Z'),
      anchor: new Date('2026-10-01T00:00:00Z'),
      n: -3,
    },
  ];
  const both = table(
    'CREATE TABLE t (id INT, ts TIMESTAMPTZ, anchor TIMESTAMPTZ, n NUMERIC)',
    rows,
    ['id', 'ts', 'anchor', 'n'],
  );

  test('a fractional or negative day count read from the row matches nothing', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'before',
        path: '$.anchor',
        offset: { value: { ago: { days: { path: '$.n' } } } },
      }),
      [1],
    );
  });

  test('a negated operator over a bad row magnitude does not match', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'notBefore',
        path: '$.anchor',
        offset: { value: { ago: { weeks: { path: '$.n' } } } },
      }),
      [1],
    );
  });

  test('a fractional hour count is fine — time units are not calendar units', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'before',
        path: '$.anchor',
        offset: { value: { ago: { hours: { path: '$.n' } } } },
      }),
      [1, 2],
    );
  });

  test('a fractional or negative context magnitude matches nothing', async () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'before',
      path: '$.anchor',
      offset: { value: { ago: { days: { path: 'k' } } } },
    });
    await both(r, [], { context: { k: 1.5 } });
    await both(r, [], { context: { k: -1 } });
  });

  test('validateRule rejects a fractional literal calendar unit', () => {
    const result = validateRule(
      rule({ field: 'ts', dateOperator: 'before', value: { ago: { days: 1.5 } } }),
    );
    expect(result.errors.map((e) => e.code)).toEqual(['invalid_relative_magnitude']);
    expect(
      validateRule(rule({ field: 'ts', dateOperator: 'before', value: { ago: { hours: 1.5 } } }))
        .ok,
    ).toBe(true);
  });
});

describe('a range with one missing end matches nothing, and negation keeps null fields only', () => {
  const rows: Row[] = [
    { id: 1, ts: new Date('2023-01-01T00:00:00Z'), n: null },
    { id: 2, ts: null, n: null },
  ];
  const both = table('CREATE TABLE t (id INT, ts TIMESTAMPTZ, n INT)', rows, ['id', 'ts', 'n']);

  test('notBetween over a context pair with a null end', async () => {
    await both(rule({ field: 'ts', dateOperator: 'notBetween', path: 'range' }), [2], {
      context: { range: ['2024-01-01T00:00:00Z', null] },
    });
  });

  test('notBetween with an end whose row magnitude is null', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'notBetween',
        value: ['2024-01-01T00:00:00Z', { ahead: { days: { path: '$.n' } } }],
      }),
      [2],
    );
  });

  test('a numeric notBetween over a context pair with a null end', async () => {
    const numbers = rule({
      field: 'n',
      operator: 'notBetween',
      path: 'range',
      offset: { value: 1 },
    });
    expect(check(numbers, { id: 1, n: 50 }, { context: { range: [10, null] } })).not.toBe(true);
    expect(check(numbers, { id: 1, n: null }, { context: { range: [10, null] } })).toBe(true);
  });
});

describe('between with row-computed ends sorts them like check()', () => {
  const rows: Row[] = [
    { id: 1, ts: new Date('2026-10-05T00:00:00Z'), n: 3 },
    { id: 2, ts: new Date('2026-09-01T00:00:00Z'), n: 3 },
  ];
  const both = table('CREATE TABLE t (id INT, ts TIMESTAMPTZ, n INT)', rows, ['id', 'ts', 'n']);

  test('ahead first, ago second', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'between',
        value: [{ ahead: { days: { path: '$.n' } } }, { ago: { days: { path: '$.n' } } }],
      }),
      [1],
    );
  });

  test('its complement', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'notBetween',
        value: [{ ahead: { days: { path: '$.n' } } }, { ago: { days: { path: '$.n' } } }],
      }),
      [2],
    );
  });
});

describe('numeric bases the compilers must take as check() does', () => {
  test('a bigint context base', () => {
    const r = rule({ field: 'n', operator: 'greaterThan', path: 'base', offset: { value: 5 } });
    expect(check(r, { n: 20 }, { context: { base: 10n } })).toBe(true);
    expect(toSql(r, { context: { base: 10n } }).params).toEqual([15]);
    expect(getWhere(toPrisma(r, { context: { base: 10n } }))).toEqual({ n: { gt: 15 } });
  });

  test('a Decimal string base', () => {
    const r = rule({
      field: 'n',
      operator: 'greaterThan',
      path: 'base',
      offset: { value: 1 },
      coerceType: 'Decimal',
    });
    expect(check(r, { n: '7' }, { context: { base: '5.5' } })).toBe(true);
    expect(toSql(r, { context: { base: '5.5' } }).params).toEqual([6.5]);
    expect(getWhere(toPrisma(r, { context: { base: '5.5' } }))).toEqual({ n: { gt: 6.5 } });
  });
});

describe('float offsets add as JS doubles on every rail', () => {
  const rows: Row[] = [{ id: 1, x: 0.30000000000000004, a: 0.1 }];
  const both = table('CREATE TABLE t (id INT, x DOUBLE PRECISION, a DOUBLE PRECISION)', rows, [
    'id',
    'x',
    'a',
  ]);

  test('a row base plus a float offset', async () => {
    await both(rule({ field: 'x', operator: 'equals', path: '$.a', offset: { value: 0.2 } }), [1]);
  });
});

describe('toPrisma refuses a date rule with no comparison source', () => {
  test('throws like toSql', () => {
    const r = rule({ field: 'ts', dateOperator: 'before' });
    expect(() => toSql(r)).toThrow('No value, path or bind');
    expect(() => toPrisma(r)).toThrow('No value, path or bind');
  });
});

describe('shifts run in the configured zone, across DST, on every rail', () => {
  // America/New_York springs forward 2026-03-08. One day after 2026-03-07 12:00 local is
  // 2026-03-08 12:00 local — 23 hours later.
  const rows: Row[] = [
    { id: 1, ts: new Date('2026-03-08T16:00:00Z'), anchor: new Date('2026-03-07T17:00:00Z'), n: 1 },
    { id: 2, ts: new Date('2026-03-08T17:00:00Z'), anchor: new Date('2026-03-07T17:00:00Z'), n: 1 },
  ];
  const both = table('CREATE TABLE t (id INT, ts TIMESTAMPTZ, anchor TIMESTAMPTZ, n INT)', rows, [
    'id',
    'ts',
    'anchor',
    'n',
  ]);
  const opts = { timeZone: 'America/New_York' };

  test('a literal offset on a row anchor', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'onOrAfter',
        path: '$.anchor',
        offset: { value: { ahead: { days: 1 } } },
      }),
      [1, 2],
      opts,
    );
    await both(
      rule({
        field: 'ts',
        dateOperator: 'before',
        path: '$.anchor',
        offset: { value: { ahead: { days: 1 } } },
      }),
      [],
      opts,
    );
  });

  test('a row magnitude on a row anchor', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'onOrAfter',
        path: '$.anchor',
        offset: { value: { ahead: { days: { path: '$.n' } } } },
      }),
      [1, 2],
      opts,
    );
  });

  test('a literal offset on a context anchor', async () => {
    await both(
      rule({
        field: 'ts',
        dateOperator: 'onOrAfter',
        path: 'anchor',
        offset: { value: { ahead: { days: 1 } } },
      }),
      [1, 2],
      { ...opts, context: { anchor: '2026-03-07T17:00:00Z' } },
    );
  });
});

describe('lens: a magnitude ref is judged by its role, not its string', () => {
  const map: FieldMap = {
    models: {
      E: {
        fields: {
          ts: { kind: 'scalar', type: 'DateTime' },
          at: { kind: 'scalar', type: 'DateTime' },
          n: { kind: 'scalar', type: 'Int' },
          ratio: { kind: 'scalar', type: 'Float' },
        },
      },
    },
  };
  const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'E' });
  const gate = (r: object) => validateRuleInLens(rule(r), lens);

  test('a DateTime path with an Int day count passes', () => {
    expect(
      gate({
        field: 'ts',
        dateOperator: 'before',
        path: '$.at',
        offset: { value: { ago: { days: { path: '$.n' } } } },
      }).ok,
    ).toBe(true);
  });

  test('a calendar unit needs a whole-number column', () => {
    const result = gate({
      field: 'ts',
      dateOperator: 'before',
      path: '$.at',
      offset: { value: { ago: { days: { path: '$.ratio' } } } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.path).toBe('$.ratio');
  });

  test('a time unit takes any number', () => {
    expect(
      gate({
        field: 'ts',
        dateOperator: 'before',
        path: '$.at',
        offset: { value: { ago: { hours: { path: '$.ratio' } } } },
      }).ok,
    ).toBe(true);
  });

  test('the comparison path is not judged as an amount', () => {
    expect(
      gate({
        field: 'ts',
        dateOperator: 'before',
        path: '$.at',
        offset: { value: { ago: { days: { path: '$.at' } } } },
      }).errors.map((v) => v.path),
    ).toEqual(['$.at']);
  });
});
