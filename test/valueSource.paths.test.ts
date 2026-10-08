import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { bindRule, check, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// A date `path` is read the same way on every rail, a null one fails closed, and a relative
// window's magnitude can itself be a path — from the row (`$.`, or bare for the root row) — or a
// caller's value through a bind.

const NOW = new Date('2026-10-06T12:00:00Z');

type Row = {
  id: number;
  ts: Date | null;
  cutoff: Date | null;
  windowSeconds: number | null;
};

const rows: Row[] = [
  {
    id: 1,
    ts: new Date('2026-10-06T09:00:00Z'),
    cutoff: new Date('2026-10-06T10:00:00Z'),
    windowSeconds: 3600,
  },
  {
    id: 2,
    ts: new Date('2026-10-06T11:00:00Z'),
    cutoff: new Date('2026-10-06T10:00:00Z'),
    windowSeconds: 14400,
  },
  { id: 3, ts: new Date('2026-10-06T09:00:00Z'), cutoff: null, windowSeconds: null },
  { id: 4, ts: null, cutoff: new Date('2026-10-06T10:00:00Z'), windowSeconds: 3600 },
];

const rule = (r: object): Condition => r as never;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE t (id INT, ts TIMESTAMPTZ, cutoff TIMESTAMPTZ, "windowSeconds" INT)`);
  for (const r of rows) {
    await db.query('INSERT INTO t VALUES ($1, $2, $3, $4)', [
      r.id,
      r.ts,
      r.cutoff,
      r.windowSeconds,
    ]);
  }
});

afterAll(async () => {
  await db.close();
});

type Bindings = Parameters<typeof bindRule>[1];

const viaCheck = (condition: Condition, bindings?: Bindings): number[] =>
  rows
    .filter((r) => check(condition, r, { now: NOW, ...(bindings ? { bindings } : {}) }) === true)
    .map((r) => r.id);

const viaSql = async (condition: Condition, bindings?: Bindings): Promise<number[]> => {
  const bound = bindings ? bindRule(condition, bindings) : condition;
  const { sql, params } = toSql(bound, { now: NOW });
  const result = await db.query<{ id: number }>(
    `SELECT id FROM t WHERE ${sql} ORDER BY id`,
    params,
  );
  return result.rows.map((r) => r.id);
};

const bothRails = async (condition: Condition, expected: number[], bindings?: Bindings) => {
  expect(viaCheck(condition, bindings)).toEqual(expected);
  expect(await viaSql(condition, bindings)).toEqual(expected);
};

describe('a row path ($.) on a date rule', () => {
  test('before compares column to column', async () => {
    await bothRails(rule({ field: 'ts', dateOperator: 'before', path: '$.cutoff' }), [1]);
  });

  test('a null path value fails closed instead of comparing against the current time', async () => {
    await bothRails(rule({ field: 'ts', dateOperator: 'after', path: '$.cutoff' }), [2]);
  });

  test('a negated operator keeps null-field rows, not null-path rows', async () => {
    await bothRails(rule({ field: 'ts', dateOperator: 'notBefore', path: '$.cutoff' }), [2, 4]);
  });
});

describe('a bare path on a date rule reads the root row', () => {
  test('it compares column to column, as `$.` does at the root', async () => {
    await bothRails(rule({ field: 'ts', dateOperator: 'before', path: 'cutoff' }), [1]);
    await bothRails(rule({ field: 'ts', dateOperator: 'notBefore', path: 'cutoff' }), [2, 4]);
  });
});

describe('a bound value on a date rule', () => {
  test('a null bound value fails closed', async () => {
    await bothRails(rule({ field: 'ts', dateOperator: 'before', bind: 'cutoff' }), [], {
      cutoff: null,
    });
  });
});

describe('a path-valued magnitude in a relative window', () => {
  const quietFor = rule({
    field: 'ts',
    dateOperator: 'before',
    value: { ago: { seconds: { path: '$.windowSeconds' } } },
  });

  test('reads each row its own window', async () => {
    // row 1: 12:00 − 1h = 11:00, 09:00 is before it; row 2: 12:00 − 4h = 08:00, 11:00 is not.
    await bothRails(quietFor, [1]);
  });

  test('a null magnitude fails closed', () => {
    expect(check(quietFor, rows[2], { now: NOW })).not.toBe(true);
  });

  test('a negated operator over a row magnitude', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'notBefore',
        value: { ago: { seconds: { path: '$.windowSeconds' } } },
      }),
      [2, 4],
    );
  });

  test('a bare magnitude reads the root row', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'before',
        value: { ago: { seconds: { path: 'windowSeconds' } } },
      }),
      [1],
    );
  });

  test('a bound magnitude resolves to a value', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'before',
        value: { ago: { hours: { bind: 'quietHours' } } },
      }),
      [1, 3],
      { quietHours: 2 },
    );
  });

  test('a magnitude that is not a number throws', () => {
    expect(() =>
      check(
        rule({
          field: 'ts',
          dateOperator: 'before',
          value: { ago: { hours: { bind: 'quietHours' } } },
        }),
        rows[0],
        { now: NOW, bindings: { quietHours: 'two' } },
      ),
    ).toThrow('hours reads a number (got two)');
  });

  test('a window on within reads its magnitude too', async () => {
    await bothRails(
      rule({ field: 'ts', dateOperator: 'within', value: { ago: { hours: { bind: 'span' } } } }),
      [2],
      { span: 2 },
    );
  });
});

describe('toPrisma and path magnitudes', () => {
  test('a bound magnitude compiles to the resolved instant', () => {
    const where = getWhere(
      toPrisma(
        bindRule(
          rule({
            field: 'ts',
            dateOperator: 'before',
            value: { ago: { hours: { bind: 'quietHours' } } },
          }),
          { quietHours: 2 },
        ),
        { now: NOW },
      ),
    );
    expect(where).toEqual({ ts: { lt: new Date('2026-10-06T10:00:00Z') } });
  });

  test('a row magnitude is rejected with a clear error', () => {
    expect(() =>
      toPrisma(
        rule({
          field: 'ts',
          dateOperator: 'before',
          value: { ago: { seconds: { path: 'windowSeconds' } } },
        }),
        { now: NOW },
      ),
    ).toThrow('Prisma rail');
    expect(() =>
      toPrisma(
        rule({
          field: 'ts',
          dateOperator: 'before',
          value: { ago: { seconds: { path: '$.windowSeconds' } } },
        }),
        { now: NOW },
      ),
    ).toThrow('Prisma rail');
  });
});
