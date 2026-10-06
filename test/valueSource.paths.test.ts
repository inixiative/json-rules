import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// A date `path` is read the same way on every rail, a null one fails closed, and a relative
// window's magnitude can itself be a path — from the row (`$.`) or from context.

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

const viaCheck = (condition: Condition, context?: Record<string, unknown>): number[] =>
  rows
    .filter((r) => check(condition, r, { now: NOW, ...(context ? { context } : {}) }) === true)
    .map((r) => r.id);

const viaSql = async (
  condition: Condition,
  context?: Record<string, unknown>,
): Promise<number[]> => {
  const { sql, params } = toSql(condition, { now: NOW, context });
  const result = await db.query<{ id: number }>(
    `SELECT id FROM t WHERE ${sql} ORDER BY id`,
    params,
  );
  return result.rows.map((r) => r.id);
};

const bothRails = async (
  condition: Condition,
  expected: number[],
  context?: Record<string, unknown>,
) => {
  expect(viaCheck(condition, context)).toEqual(expected);
  expect(await viaSql(condition, context)).toEqual(expected);
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

describe('a context path on a date rule', () => {
  test('a null context value fails closed', async () => {
    await bothRails(rule({ field: 'ts', dateOperator: 'before', path: 'cutoff' }), [], {
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

  test('a context magnitude resolves to a value', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'before',
        value: { ago: { hours: { path: 'quietHours' } } },
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
          value: { ago: { hours: { path: 'quietHours' } } },
        }),
        rows[0],
        { now: NOW, context: { quietHours: 'two' } },
      ),
    ).toThrow('quietHours');
  });

  test('a window on within reads its magnitude too', async () => {
    await bothRails(
      rule({ field: 'ts', dateOperator: 'within', value: { ago: { hours: { path: 'span' } } } }),
      [2],
      { span: 2 },
    );
  });
});

describe('toPrisma and path magnitudes', () => {
  test('a context magnitude compiles to the resolved instant', () => {
    const where = getWhere(
      toPrisma(
        rule({
          field: 'ts',
          dateOperator: 'before',
          value: { ago: { hours: { path: 'quietHours' } } },
        }),
        { now: NOW, context: { quietHours: 2 } },
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
          value: { ago: { seconds: { path: '$.windowSeconds' } } },
        }),
        { now: NOW },
      ),
    ).toThrow('toPrisma');
  });
});
