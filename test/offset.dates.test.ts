import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, resolveBindings, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// A date `offset` is the rolling shape anchored on the resolved value instead of now:
// `ts before anchor − 7 days` is `{ path: '$.anchor', offset: { ago: { days: 7 } } }`.

const NOW = new Date('2026-10-06T00:00:00Z');

type Row = { id: number; ts: Date | null; anchor: Date | null; days: number | null };

const d = (iso: string) => new Date(iso);

const rows: Row[] = [
  { id: 1, ts: d('2026-09-20T00:00:00Z'), anchor: d('2026-10-01T00:00:00Z'), days: 7 },
  { id: 2, ts: d('2026-09-28T00:00:00Z'), anchor: d('2026-10-01T00:00:00Z'), days: 7 },
  { id: 3, ts: d('2026-09-20T00:00:00Z'), anchor: null, days: 7 },
  { id: 4, ts: null, anchor: d('2026-10-01T00:00:00Z'), days: 7 },
  { id: 5, ts: d('2026-09-28T00:00:00Z'), anchor: d('2026-10-01T00:00:00Z'), days: null },
  // Month-end: 2024-02-29 + 1 year 1 month is 2025-03-29 when months apply as one step.
  { id: 6, ts: d('2025-03-29T00:00:00Z'), anchor: d('2024-02-29T00:00:00Z'), days: 0 },
];

const rule = (r: object): Condition => r as never;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`SET TIME ZONE 'UTC'`);
  await db.exec('CREATE TABLE t (id INT, ts TIMESTAMPTZ, anchor TIMESTAMPTZ, days INT)');
  for (const r of rows) {
    await db.query('INSERT INTO t VALUES ($1, $2, $3, $4)', [r.id, r.ts, r.anchor, r.days]);
  }
});

afterAll(async () => {
  await db.close();
});

type Opts = { context?: Record<string, unknown>; bindings?: Record<string, unknown> };

const ids = async (condition: Condition, opts: Opts = {}) => {
  const inMemory = rows
    .filter((r) => check(condition, r, { now: NOW, ...opts } as never) === true)
    .map((r) => r.id);
  const compiled = opts.bindings ? resolveBindings(condition, opts.bindings as never) : condition;
  const { sql, params } = toSql(compiled, { now: NOW, context: opts.context });
  const viaSql = (
    await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
  ).rows.map((r) => r.id);
  return { inMemory, viaSql };
};

const bothRails = async (condition: Condition, expected: number[], opts: Opts = {}) => {
  const { inMemory, viaSql } = await ids(condition, opts);
  expect(inMemory).toEqual(expected);
  expect(viaSql).toEqual(expected);
};

describe('offset on a row path', () => {
  test('ago', async () => {
    // before anchor − 7 days (09-24): row 1; a null anchor or ts never matches.
    await bothRails(
      rule({ field: 'ts', dateOperator: 'before', path: '$.anchor', offset: { ago: { days: 7 } } }),
      [1],
    );
  });

  test('ahead', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'onOrAfter',
        path: '$.anchor',
        offset: { ahead: { years: 1, months: 1 } },
      }),
      [6],
    );
  });

  test('a row-path magnitude', async () => {
    // before anchor − days: row 1; row 5's null days fails closed.
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'before',
        path: '$.anchor',
        offset: { ago: { days: { path: '$.days' } } },
      }),
      [1],
    );
  });

  test('a negated operator keeps null-field rows only', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'notBefore',
        path: '$.anchor',
        offset: { ago: { days: { path: '$.days' } } },
      }),
      [2, 4, 6],
    );
  });
});

describe('offset on a context path', () => {
  test('a literal offset', async () => {
    await bothRails(
      rule({ field: 'ts', dateOperator: 'before', path: 'anchor', offset: { ago: { days: 7 } } }),
      [1, 3, 6],
      { context: { anchor: '2026-10-01T00:00:00Z' } },
    );
  });

  test('between shifts both endpoints', async () => {
    // [09-01, 09-10] + 15 days = [09-16, 09-25].
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'between',
        path: 'window',
        offset: { ahead: { days: 15 } },
      }),
      [1, 3],
      { context: { window: ['2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z'] } },
    );
  });

  test('a null context value fails closed', async () => {
    await bothRails(
      rule({ field: 'ts', dateOperator: 'before', path: 'anchor', offset: { ago: { days: 7 } } }),
      [],
      { context: { anchor: null } },
    );
  });
});

describe('offset on a bind', () => {
  test('a bound date', async () => {
    await bothRails(
      rule({ field: 'ts', dateOperator: 'before', bind: 'anchor', offset: { ago: { days: 7 } } }),
      [1, 3, 6],
      { bindings: { anchor: '2026-10-01T00:00:00Z' } },
    );
  });

  test('a bound date expression, shifted', async () => {
    // now − 5 days = 10-01, − 7 days = 09-24.
    await bothRails(
      rule({ field: 'ts', dateOperator: 'before', bind: 'anchor', offset: { ago: { days: 7 } } }),
      [1, 3, 6],
      { bindings: { anchor: { ago: { days: 5 } } } },
    );
  });

  test('a context-path magnitude', async () => {
    await bothRails(
      rule({
        field: 'ts',
        dateOperator: 'before',
        bind: 'anchor',
        offset: { ago: { days: { path: 'grace' } } },
      }),
      [1, 3, 6],
      { bindings: { anchor: '2026-10-01T00:00:00Z' }, context: { grace: 7 } },
    );
  });
});

describe('toPrisma and date offsets', () => {
  test('a context path plus a literal offset compiles to the shifted instant', () => {
    const where = getWhere(
      toPrisma(
        rule({ field: 'ts', dateOperator: 'before', path: 'anchor', offset: { ago: { days: 7 } } }),
        { context: { anchor: '2026-10-01T00:00:00Z' } },
      ),
    );
    expect(where).toEqual({ ts: { lt: new Date('2026-09-24T00:00:00Z') } });
  });

  test('a resolved bind plus an offset compiles', () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'before',
      bind: 'anchor',
      offset: { ago: { days: 7 } },
    });
    expect(
      getWhere(toPrisma(resolveBindings(r, { anchor: '2026-10-01T00:00:00Z' }), { now: NOW })),
    ).toEqual({ ts: { lt: new Date('2026-09-24T00:00:00Z') } });
  });

  test('a row-path magnitude is rejected', () => {
    expect(() =>
      toPrisma(
        rule({
          field: 'ts',
          dateOperator: 'before',
          path: 'anchor',
          offset: { ago: { days: { path: '$.days' } } },
        }),
        { context: { anchor: '2026-10-01T00:00:00Z' } },
      ),
    ).toThrow('toPrisma');
  });
});
