import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, toSql } from '../index';

// Date comparison values sourced from `path` get the SAME anchoring a literal gets, on
// both rails: toSql routes the context-path branch through the parse-and-anchor seam,
// and checkDate's two-date operators resolve `path` like the one-date ones already do.

const rows = [
  { id: 1, ts: new Date('2024-06-16T20:00:00Z') },
  { id: 2, ts: new Date('2024-06-18T02:00:00Z') },
  { id: 3, ts: null },
];

describe('toSql anchors context-path date values', () => {
  it('a naive string from context compiles to the same anchored param as a literal', () => {
    const literal = toSql({ field: 'ts', dateOperator: 'before', value: '2024-06-17' } as never);
    const viaPath = toSql({ field: 'ts', dateOperator: 'before', path: 'cutoff' } as never, {
      context: { cutoff: '2024-06-17' },
    });
    expect(viaPath.sql).toBe(literal.sql);
    expect(viaPath.params).toEqual(literal.params);
    expect(viaPath.params[0]).toBeInstanceOf(Date);
  });

  it('between endpoints from a context path anchor per element', () => {
    const literal = toSql({
      field: 'ts',
      dateOperator: 'between',
      value: ['2024-06-16', '2024-06-18'],
    } as never);
    const viaPath = toSql({ field: 'ts', dateOperator: 'between', path: 'range' } as never, {
      context: { range: ['2024-06-16', '2024-06-18'] },
    });
    expect(viaPath.params).toEqual(literal.params);
  });
});

describe('checkDate resolves path for between/notBetween', () => {
  const between: Condition = { field: 'ts', dateOperator: 'between', path: 'range' } as never;
  const context = { range: ['2024-06-16', '2024-06-18'] };

  test('between via context path evaluates instead of throwing', () => {
    expect(check(between, { ts: new Date('2024-06-17T00:00:00Z') }, { context })).toBe(true);
    expect(check(between, { ts: new Date('2024-06-20T00:00:00Z') }, { context })).not.toBe(true);
  });

  test('notBetween via context path evaluates', () => {
    const rule: Condition = { field: 'ts', dateOperator: 'notBetween', path: 'range' } as never;
    expect(check(rule, { ts: new Date('2024-06-20T00:00:00Z') }, { context })).toBe(true);
  });

  test('between via a $. row path evaluates', () => {
    const rule: Condition = { field: 'ts', dateOperator: 'between', path: '$.window' } as never;
    const row = {
      ts: new Date('2024-06-17T00:00:00Z'),
      window: ['2024-06-16', '2024-06-18'],
    };
    expect(check(rule, row, {})).toBe(true);
  });
});

describe('both rails classify the same rows for a path-sourced cutoff', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE t (id INT, ts TIMESTAMPTZ)`);
    await db.exec(
      `INSERT INTO t VALUES (1,'2024-06-16T20:00:00Z'), (2,'2024-06-18T02:00:00Z'), (3,NULL)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('before via context path', async () => {
    const rule: Condition = { field: 'ts', dateOperator: 'before', path: 'cutoff' } as never;
    const opts = { context: { cutoff: '2024-06-17' } };
    const inMemory = rows.filter((r) => check(rule, r, opts) === true).map((r) => r.id);
    const { sql, params } = toSql(rule, opts);
    const viaSql = (
      await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql}`, params)
    ).rows.map((r) => r.id);
    expect(viaSql).toEqual(inMemory);
  });
});
