import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { bindRule, check, toSql } from '../index';

// Date comparison values from a value source get the SAME anchoring a literal gets, on both
// rails: a caller's value is a bind (resolved by bindRule before compiling, read from `bindings`
// by check()), a row's is a path, and checkDate's two-date operators resolve either like the
// one-date ones do.

const rows = [
  { id: 1, ts: new Date('2024-06-16T20:00:00Z') },
  { id: 2, ts: new Date('2024-06-18T02:00:00Z') },
  { id: 3, ts: null },
];

describe('toSql anchors bound date values', () => {
  it('a bound naive string compiles to the same anchored param as a literal', () => {
    const literal = toSql({ field: 'ts', dateOperator: 'before', value: '2024-06-17' } as never);
    const bound = toSql(
      bindRule({ field: 'ts', dateOperator: 'before', bind: 'cutoff' } as never, {
        cutoff: '2024-06-17',
      }),
    );
    expect(bound.sql).toBe(literal.sql);
    expect(bound.params).toEqual(literal.params);
    expect(bound.params[0]).toBe('2024-06-17T00:00:00.000Z');
  });

  it('bound between endpoints anchor per element', () => {
    const literal = toSql({
      field: 'ts',
      dateOperator: 'between',
      value: ['2024-06-16', '2024-06-18'],
    } as never);
    const bound = toSql(
      bindRule({ field: 'ts', dateOperator: 'between', bind: 'range' } as never, {
        range: ['2024-06-16', '2024-06-18'],
      }),
    );
    expect(bound.params).toEqual(literal.params);
  });
});

describe('checkDate resolves a bind or a path for between/notBetween', () => {
  const between: Condition = { field: 'ts', dateOperator: 'between', bind: 'range' } as never;
  const bindings = { range: ['2024-06-16', '2024-06-18'] };

  test('between via a bind evaluates instead of throwing', () => {
    expect(check(between, { ts: new Date('2024-06-17T00:00:00Z') }, { bindings })).toBe(true);
    expect(check(between, { ts: new Date('2024-06-20T00:00:00Z') }, { bindings })).not.toBe(true);
  });

  test('notBetween via a bind evaluates', () => {
    const rule: Condition = { field: 'ts', dateOperator: 'notBetween', bind: 'range' } as never;
    expect(check(rule, { ts: new Date('2024-06-20T00:00:00Z') }, { bindings })).toBe(true);
  });

  test('between via a $. row path evaluates', () => {
    const rule: Condition = { field: 'ts', dateOperator: 'between', path: '$.window' } as never;
    const row = {
      ts: new Date('2024-06-17T00:00:00Z'),
      window: ['2024-06-16', '2024-06-18'],
    };
    expect(check(rule, row, {})).toBe(true);
  });

  test('between via a bare path reads the root row', () => {
    const rule: Condition = { field: 'ts', dateOperator: 'between', path: 'window' } as never;
    const row = { ts: new Date('2024-06-17T00:00:00Z'), window: ['2024-06-16', '2024-06-18'] };
    expect(check(rule, row, {})).toBe(true);
    expect(check(rule, { ...row, window: ['2024-06-18', '2024-06-19'] }, {})).not.toBe(true);
  });
});

describe('both rails classify the same rows for a bound cutoff', () => {
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

  it('before via a bound cutoff', async () => {
    const rule: Condition = { field: 'ts', dateOperator: 'before', bind: 'cutoff' } as never;
    const bindings = { cutoff: '2024-06-17' };
    const inMemory = rows.filter((r) => check(rule, r, { bindings }) === true).map((r) => r.id);
    const { sql, params } = toSql(bindRule(rule, bindings));
    const viaSql = (
      await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql}`, params)
    ).rows.map((r) => r.id);
    expect(viaSql).toEqual(inMemory);
  });
});
