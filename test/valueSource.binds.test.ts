import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, resolveBindings, toPrisma, toSql, validateRule } from '../index';
import { getWhere } from './fixtures/helpers';

// One reader for every rule kind: a `bind` resolves on check() for field, date and aggregate
// rules with the same key-presence contract, and validateRule accepts it as a value source.

const NOW = new Date('2026-10-06T12:00:00Z');
const rule = (r: object): Condition => r as never;

describe('check() reads a bind on every rule kind', () => {
  test('field', () => {
    const r = rule({ field: 'score', operator: 'greaterThan', bind: 'min' });
    expect(check(r, { score: 7 }, { bindings: { min: 5 } })).toBe(true);
    expect(check(r, { score: 3 }, { bindings: { min: 5 } })).not.toBe(true);
  });

  test('date', () => {
    const r = rule({ field: 'ts', dateOperator: 'before', bind: 'cutoff' });
    const bindings = { cutoff: '2026-10-06T10:00:00Z' };
    expect(check(r, { ts: '2026-10-06T09:00:00Z' }, { bindings })).toBe(true);
    expect(check(r, { ts: '2026-10-06T11:00:00Z' }, { bindings })).not.toBe(true);
  });

  test('a bound date expression resolves against now', () => {
    const r = rule({ field: 'ts', dateOperator: 'before', bind: 'quietWindow' });
    const opts = { now: NOW, bindings: { quietWindow: { ago: { hours: 2 } } } };
    expect(check(r, { ts: '2026-10-06T09:00:00Z' }, opts)).toBe(true);
    expect(check(r, { ts: '2026-10-06T11:00:00Z' }, opts)).not.toBe(true);
  });

  test('aggregate', () => {
    const r = rule({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: 'greaterThan',
      bind: 'min',
    });
    expect(check(r, { scores: [3, 4] }, { bindings: { min: 5 } })).toBe(true);
    expect(check(r, { scores: [1, 2] }, { bindings: { min: 5 } })).not.toBe(true);
  });

  test('an unsupplied binding throws on every kind', () => {
    for (const r of [
      rule({ field: 'score', operator: 'equals', bind: 'x' }),
      rule({ field: 'ts', dateOperator: 'before', bind: 'x' }),
      rule({ field: 'scores', aggregate: { mode: 'sum' }, operator: 'equals', bind: 'x' }),
    ]) {
      expect(() => check(r, { score: 1, ts: NOW, scores: [1] }, { bindings: {} })).toThrow(
        'Missing binding for "x"',
      );
    }
  });

  test('a binding named like a prototype key does not resolve from Object.prototype', () => {
    expect(() =>
      check(
        rule({ field: 'ts', dateOperator: 'before', bind: 'toString' }),
        { ts: NOW },
        {
          bindings: {},
        },
      ),
    ).toThrow('Missing binding for "toString"');
  });
});

describe('an optional or null date bind fails closed on every rail', () => {
  let db: PGlite;
  const rows = [
    { id: 1, ts: new Date('2026-10-06T09:00:00Z') },
    { id: 2, ts: null },
  ];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE TABLE t (id INT, ts TIMESTAMPTZ)');
    await db.exec(`INSERT INTO t VALUES (1, '2026-10-06T09:00:00Z'), (2, NULL)`);
  });

  afterAll(async () => {
    await db.close();
  });

  const both = async (r: Condition, bindings: Record<string, unknown>, expected: number[]) => {
    const inMemory = rows
      .filter((row) => check(r, row, { now: NOW, bindings: bindings as never }) === true)
      .map((row) => row.id);
    const { sql, params } = toSql(resolveBindings(r, bindings as never), { now: NOW });
    const viaSql = (
      await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
    ).rows.map((row) => row.id);
    expect(inMemory).toEqual(expected);
    expect(viaSql).toEqual(expected);
  };

  test('an unsupplied optional bind matches nothing on a positive operator', async () => {
    await both(
      rule({ field: 'ts', dateOperator: 'before', bind: 'x', bindOptional: true }),
      {},
      [],
    );
  });

  test('an unsupplied optional bind keeps only null-field rows on a negated operator', async () => {
    await both(
      rule({ field: 'ts', dateOperator: 'notBefore', bind: 'x', bindOptional: true }),
      {},
      [2],
    );
  });

  test('a supplied null bind fails closed', async () => {
    await both(rule({ field: 'ts', dateOperator: 'before', bind: 'x' }), { x: null }, []);
  });

  test('the compilers refuse an unresolved required date bind', () => {
    const r = rule({ field: 'ts', dateOperator: 'before', bind: 'x' });
    expect(() => toSql(r)).toThrow('Unresolved binding');
    expect(() => toPrisma(r)).toThrow('Unresolved binding');
  });

  test('toPrisma compiles a resolved date bind', () => {
    const r = rule({ field: 'ts', dateOperator: 'before', bind: 'x' });
    expect(getWhere(toPrisma(resolveBindings(r, { x: '2026-10-06T10:00:00Z' })))).toEqual({
      ts: { lt: new Date('2026-10-06T10:00:00Z') },
    });
  });
});

describe('validateRule accepts bind as a value source', () => {
  test('field, date and aggregate', () => {
    expect(validateRule(rule({ field: 'a', operator: 'equals', bind: 'x' })).ok).toBe(true);
    expect(validateRule(rule({ field: 'ts', dateOperator: 'before', bind: 'x' })).ok).toBe(true);
    expect(
      validateRule(rule({ field: 'xs', aggregate: { mode: 'sum' }, operator: 'equals', bind: 'x' }))
        .ok,
    ).toBe(true);
  });

  test('two sources are ambiguous', () => {
    const result = validateRule(rule({ field: 'a', operator: 'equals', bind: 'x', path: 'y' }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('ambiguous_value_source');
  });

  test('bind on a no-value operator is rejected', () => {
    const result = validateRule(rule({ field: 'a', operator: 'isEmpty', bind: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('unexpected_bind');
  });
});
