import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { bindRule, check, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// A numeric `offset` shifts a path or bound comparison value: `score >= avg + 5`. The offset
// is a signed number or `{ path }`, and NULL anywhere on the right fails closed.

type Row = { id: number; score: number | null; avg: number | null; delta: number | null };

const rows: Row[] = [
  { id: 1, score: 15, avg: 10, delta: 5 },
  { id: 2, score: 12, avg: 10, delta: 1 },
  { id: 3, score: 15, avg: null, delta: 5 },
  { id: 4, score: null, avg: 10, delta: 5 },
  { id: 5, score: 12, avg: 10, delta: null },
];

const rule = (r: object): Condition => r as never;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE t (id INT, score INT, avg INT, delta INT)');
  for (const r of rows) {
    await db.query('INSERT INTO t VALUES ($1, $2, $3, $4)', [r.id, r.score, r.avg, r.delta]);
  }
});

afterAll(async () => {
  await db.close();
});

type Opts = { bindings?: Record<string, unknown> };

const bothRails = async (condition: Condition, expected: number[], opts: Opts = {}) => {
  const inMemory = rows.filter((r) => check(condition, r, opts as never) === true).map((r) => r.id);
  const compiled = opts.bindings ? bindRule(condition, opts.bindings as never) : condition;
  const { sql, params } = toSql(compiled);
  const viaSql = (
    await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
  ).rows.map((r) => r.id);
  expect(inMemory).toEqual(expected);
  expect(viaSql).toEqual(expected);
};

describe('offset on a row path', () => {
  test('a positive literal', async () => {
    // score >= avg + 5: row 1 (15 >= 15); row 2 (12 < 15); null avg or score never matches.
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', path: '$.avg', offset: { value: 5 } }),
      [1],
    );
  });

  test('a bare path is the root row: the same column as $.', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', path: 'avg', offset: { value: 5 } }),
      [1],
    );
    await bothRails(
      rule({
        field: 'score',
        operator: 'greaterThanEquals',
        path: 'avg',
        offset: { path: 'delta' },
      }),
      [1, 2],
    );
  });

  test('a negative literal', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', path: '$.avg', offset: { value: -3 } }),
      [1, 2, 5],
    );
  });

  test('a row-path offset', async () => {
    // score >= avg + delta: row 1 (15 >= 15), row 2 (12 >= 11); a null delta fails closed.
    await bothRails(
      rule({
        field: 'score',
        operator: 'greaterThanEquals',
        path: '$.avg',
        offset: { path: '$.delta' },
      }),
      [1, 2],
    );
  });

  test('equals', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'equals', path: '$.avg', offset: { value: 2 } }),
      [2, 5],
    );
  });

  test('lessThan', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'lessThan', path: '$.avg', offset: { value: 3 } }),
      [2, 5],
    );
  });
});

describe('offset on a bind', () => {
  test('a literal offset', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', bind: 'target', offset: { value: 3 } }),
      [1, 3],
      { bindings: { target: 10 } },
    );
  });

  test('a row-path offset on a bound value', async () => {
    // score >= 10 + delta: rows 1 and 3 (15 >= 15), row 2 (12 >= 11); null delta fails closed.
    await bothRails(
      rule({
        field: 'score',
        operator: 'greaterThanEquals',
        bind: 'target',
        offset: { path: '$.delta' },
      }),
      [1, 2, 3],
      { bindings: { target: 10 } },
    );
  });

  test('between shifts both endpoints', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'between', bind: 'range', offset: { value: 2 } }),
      [1, 2, 3, 5],
      { bindings: { range: [10, 13] } },
    );
  });

  test('a null bound value fails closed', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', bind: 'target', offset: { value: 3 } }),
      [],
      { bindings: { target: null } },
    );
  });

  test('a bound offset', async () => {
    await bothRails(
      rule({
        field: 'score',
        operator: 'greaterThanEquals',
        bind: 'target',
        offset: { bind: 'margin' },
      }),
      [1, 3],
      { bindings: { target: 10, margin: 3 } },
    );
  });
});

describe('check() rejects an offset it cannot apply', () => {
  test('a non-numeric comparison value', () => {
    expect(() =>
      check(
        rule({
          field: 'score',
          operator: 'greaterThanEquals',
          bind: 'target',
          offset: { value: 3 },
        }),
        rows[0],
        { bindings: { target: 'ten' } },
      ),
    ).toThrow('offset');
  });

  test('a non-numeric offset', () => {
    expect(() =>
      check(
        rule({
          field: 'score',
          operator: 'greaterThanEquals',
          bind: 'target',
          offset: { bind: 'margin' },
        }),
        rows[0],
        { bindings: { target: 10, margin: 'three' } },
      ),
    ).toThrow('an offset reads a number');
  });

  test('a non-numeric offset read from the row', () => {
    expect(() =>
      check(
        rule({
          field: 'score',
          operator: 'greaterThanEquals',
          bind: 'target',
          offset: { path: 'margin' },
        }),
        { ...rows[0], margin: 'three' },
        { bindings: { target: 10 } },
      ),
    ).toThrow('an offset reads a number');
  });
});

describe('toPrisma and numeric offsets', () => {
  test('a resolved bind plus a literal offset compiles to the shifted value', () => {
    const r = rule({
      field: 'score',
      operator: 'greaterThanEquals',
      bind: 'target',
      offset: { value: 3 },
    });
    expect(getWhere(toPrisma(bindRule(r, { target: 10 })))).toEqual({ score: { gte: 13 } });
  });

  test('a resolved bind plus a resolved bound offset compiles', () => {
    const r = rule({
      field: 'score',
      operator: 'greaterThanEquals',
      bind: 'target',
      offset: { bind: 'margin' },
    });
    const where = getWhere(toPrisma(bindRule(r, { target: 10, margin: 3 })));
    expect(where).toEqual({ score: { gte: 13 } });
  });

  test('a row-path offset is rejected: Prisma has no arithmetic', () => {
    for (const path of ['$.delta', 'delta'])
      expect(() =>
        toPrisma(
          bindRule(
            rule({
              field: 'score',
              operator: 'greaterThanEquals',
              bind: 'target',
              offset: { path },
            }),
            { target: 10 },
          ),
        ),
      ).toThrow('Prisma rail');
  });

  test('a column compared with an offset is rejected', () => {
    expect(() =>
      toPrisma(
        rule({ field: 'score', operator: 'greaterThanEquals', path: 'avg', offset: { value: 3 } }),
      ),
    ).toThrow('Prisma rail');
  });
});
