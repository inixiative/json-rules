import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, resolveBindings, toPrisma, toSql } from '../index';
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

type Opts = { context?: Record<string, unknown>; bindings?: Record<string, unknown> };

const bothRails = async (condition: Condition, expected: number[], opts: Opts = {}) => {
  const inMemory = rows.filter((r) => check(condition, r, opts as never) === true).map((r) => r.id);
  const compiled = opts.bindings ? resolveBindings(condition, opts.bindings as never) : condition;
  const { sql, params } = toSql(compiled, { context: opts.context });
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
      rule({ field: 'score', operator: 'greaterThanEquals', path: '$.avg', offset: 5 }),
      [1],
    );
  });

  test('a negative literal', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', path: '$.avg', offset: -3 }),
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
    await bothRails(rule({ field: 'score', operator: 'equals', path: '$.avg', offset: 2 }), [2, 5]);
  });

  test('lessThan', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'lessThan', path: '$.avg', offset: 3 }),
      [2, 5],
    );
  });
});

describe('offset on a context path', () => {
  test('a literal offset', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', path: 'target', offset: 3 }),
      [1, 3],
      { context: { target: 10 } },
    );
  });

  test('a row-path offset on a context value', async () => {
    // score >= 10 + delta: rows 1 and 3 (15 >= 15), row 2 (12 >= 11); null delta fails closed.
    await bothRails(
      rule({
        field: 'score',
        operator: 'greaterThanEquals',
        path: 'target',
        offset: { path: '$.delta' },
      }),
      [1, 2, 3],
      { context: { target: 10 } },
    );
  });

  test('between shifts both endpoints', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'between', path: 'range', offset: 2 }),
      [1, 2, 3, 5],
      { context: { range: [10, 13] } },
    );
  });

  test('a null context value fails closed', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', path: 'target', offset: 3 }),
      [],
      { context: { target: null } },
    );
  });
});

describe('offset on a bind', () => {
  test('a literal offset', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'greaterThanEquals', bind: 'target', offset: 3 }),
      [1, 3],
      { bindings: { target: 10 } },
    );
  });

  test('a context-path offset', async () => {
    await bothRails(
      rule({
        field: 'score',
        operator: 'greaterThanEquals',
        bind: 'target',
        offset: { path: 'margin' },
      }),
      [1, 3],
      { bindings: { target: 10 }, context: { margin: 3 } },
    );
  });
});

describe('check() rejects an offset it cannot apply', () => {
  test('a non-numeric comparison value', () => {
    expect(() =>
      check(
        rule({ field: 'score', operator: 'greaterThanEquals', path: 'target', offset: 3 }),
        rows[0],
        { context: { target: 'ten' } },
      ),
    ).toThrow('offset');
  });

  test('a non-numeric offset path', () => {
    expect(() =>
      check(
        rule({
          field: 'score',
          operator: 'greaterThanEquals',
          path: 'target',
          offset: { path: 'margin' },
        }),
        rows[0],
        { context: { target: 10, margin: 'three' } },
      ),
    ).toThrow('margin');
  });
});

describe('toPrisma and numeric offsets', () => {
  test('a context path plus a literal offset compiles to the shifted value', () => {
    const where = getWhere(
      toPrisma(rule({ field: 'score', operator: 'greaterThanEquals', path: 'target', offset: 3 }), {
        context: { target: 10 },
      }),
    );
    expect(where).toEqual({ score: { gte: 13 } });
  });

  test('a resolved bind plus a context-path offset compiles', () => {
    const r = rule({
      field: 'score',
      operator: 'greaterThanEquals',
      bind: 'target',
      offset: { path: 'margin' },
    });
    const where = getWhere(
      toPrisma(resolveBindings(r, { target: 10 }), { context: { margin: 3 } }),
    );
    expect(where).toEqual({ score: { gte: 13 } });
  });

  test('a row-path offset is rejected', () => {
    expect(() =>
      toPrisma(
        rule({
          field: 'score',
          operator: 'greaterThanEquals',
          path: 'target',
          offset: { path: '$.delta' },
        }),
        { context: { target: 10 } },
      ),
    ).toThrow('toPrisma');
  });
});
