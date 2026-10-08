import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { bindRule, check, listBindings, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// One value-source type in every slot: a unit amount and the evaluation's time zone take
// `{ value } | { path } | { bind }` like a comparison value or an offset does.

const NOW = new Date('2026-10-06T12:00:00Z');
const rule = (r: object): Condition => r as never;

const withinBoundHours = rule({
  field: 'ts',
  dateOperator: 'after',
  value: { ago: { hours: { bind: 'quietHours' } } },
});

describe('a bound unit amount', () => {
  const rows = [
    { id: 1, ts: new Date('2026-10-06T11:00:00Z') },
    { id: 2, ts: new Date('2026-10-06T08:00:00Z') },
  ];
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`SET TIME ZONE 'UTC'; CREATE TABLE t (id INT, ts TIMESTAMPTZ)`);
    for (const r of rows) await db.query('INSERT INTO t VALUES ($1, $2)', [r.id, r.ts]);
  });
  afterAll(async () => {
    await db.close();
  });

  test('check() reads it from bindings', () => {
    const opts = { now: NOW, bindings: { quietHours: 2 } };
    expect(rows.filter((r) => check(withinBoundHours, r, opts) === true).map((r) => r.id)).toEqual([
      1,
    ]);
  });

  test('it is a binding the tree names and requires', () => {
    expect(listBindings(withinBoundHours)).toEqual(['quietHours']);
    expect(listBindings(withinBoundHours, { required: true })).toEqual(['quietHours']);
    const offsetAmount = rule({
      field: 'ts',
      dateOperator: 'before',
      path: 'anchor',
      offset: { value: { ahead: { days: { bind: 'grace', bindOptional: true } } } },
    });
    expect(listBindings(offsetAmount)).toEqual(['grace']);
    expect(listBindings(offsetAmount, { required: true })).toEqual([]);
  });

  test('bindRule rewrites it, and both compilers then agree with check()', async () => {
    const resolved = bindRule(withinBoundHours, { quietHours: 2 });
    expect(resolved).toEqual(
      rule({ field: 'ts', dateOperator: 'after', value: { ago: { hours: { value: 2 } } } }),
    );
    const { sql, params } = toSql(resolved, { now: NOW });
    const viaSql = (await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql}`, params)).rows;
    expect(viaSql.map((r) => r.id)).toEqual([1]);
    expect(getWhere(toPrisma(resolved, { now: NOW }))).toEqual({
      ts: { gt: new Date('2026-10-06T10:00:00Z') },
    });
  });

  test('an unresolved one is a compile error, and an optional one matches nothing', () => {
    expect(() => toSql(withinBoundHours, { now: NOW })).toThrow("Unresolved binding 'quietHours'");
    expect(() => toPrisma(withinBoundHours, { now: NOW })).toThrow(
      "Unresolved binding 'quietHours'",
    );
    const optional = rule({
      field: 'ts',
      dateOperator: 'after',
      value: { ago: { hours: { bind: 'quietHours', bindOptional: true } } },
    });
    expect(check(optional, rows[0], { now: NOW })).not.toBe(true);
    expect(toSql(optional, { now: NOW }).sql).toBe('FALSE');
  });

  test('a bound amount the unit cannot take is a caller error', () => {
    const days = rule({
      field: 'ts',
      dateOperator: 'after',
      value: { ago: { days: { bind: 'd' } } },
    });
    expect(() => check(days, rows[0], { now: NOW, bindings: { d: 1.5 } })).toThrow('whole');
  });
});

describe('the time zone is a value source', () => {
  const naive = rule({ field: 'ts', dateOperator: 'after', value: '2024-06-15' });

  test('a path is refused on every rail: one zone per evaluation, and a path reads the row', () => {
    const fromPath = { timeZone: { path: 'tz' } };
    const row = { ts: new Date('2024-06-16T00:00:00Z'), tz: 'Asia/Kolkata' };
    expect(() => check(naive, row, fromPath)).toThrow('one per evaluation');
    expect(() => toSql(naive, fromPath)).toThrow('one per evaluation');
    expect(() => toPrisma(naive, fromPath)).toThrow('one per evaluation');
  });

  test('check() reads a bound zone as it reads the zone given directly', () => {
    const at = { ts: new Date('2024-06-14T20:00:00Z') };
    const bound = { timeZone: { bind: 'tz' }, bindings: { tz: 'Asia/Kolkata' } };
    expect(check(naive, at, bound)).toBe(check(naive, at, { timeZone: 'Asia/Kolkata' }));
    expect(check(naive, at, bound)).not.toBe(check(naive, at, { timeZone: 'UTC' }));
  });

  test('an unresolved zone bind is a compile error, not a silent UTC', () => {
    expect(() => toSql(naive, { timeZone: { bind: 'tz' } })).toThrow("Unresolved binding 'tz'");
    expect(() => toPrisma(naive, { timeZone: { bind: 'tz' } })).toThrow("Unresolved binding 'tz'");
    expect(toSql(naive, { timeZone: { bind: 'tz', bindOptional: true } }).params).toEqual(
      toSql(naive).params,
    );
  });
});
