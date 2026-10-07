import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { bindRule, check, toSql } from '../index';

// A date rule's `bind` is its comparison value supplied at evaluation time — a date or a
// date expression — with the same key-presence contract as a field rule's bind.

const now = new Date('2026-10-06T12:00:00Z');
const quietFor: Condition = {
  field: 'lastBreachedAt',
  dateOperator: 'before',
  bind: 'quietWindow',
} as never;

const rows = [
  { id: 1, lastBreachedAt: new Date('2026-10-06T09:00:00Z') },
  { id: 2, lastBreachedAt: new Date('2026-10-06T11:00:00Z') },
  { id: 3, lastBreachedAt: null },
];

describe('check() resolves a date rule bind', () => {
  test('a bound relative expression resolves against now', () => {
    const opts = { now, bindings: { quietWindow: { ago: { hours: 2 } } } };
    expect(check(quietFor, rows[0], opts)).toBe(true);
    expect(check(quietFor, rows[1], opts)).not.toBe(true);
  });

  test('a bound absolute date compares as a literal would', () => {
    const opts = { bindings: { quietWindow: '2026-10-06T10:00:00Z' } };
    expect(check(quietFor, rows[0], opts)).toBe(true);
    expect(check(quietFor, rows[1], opts)).not.toBe(true);
  });

  test('a bound range feeds between', () => {
    const rule: Condition = {
      field: 'lastBreachedAt',
      dateOperator: 'between',
      bind: 'range',
    } as never;
    const opts = { bindings: { range: ['2026-10-06T08:00:00Z', '2026-10-06T10:00:00Z'] } };
    expect(check(rule, rows[0], opts)).toBe(true);
    expect(check(rule, rows[1], opts)).not.toBe(true);
  });

  test('a null field is a non-match, as with a literal', () => {
    const opts = { now, bindings: { quietWindow: { ago: { hours: 2 } } } };
    expect(check(quietFor, rows[2], opts)).not.toBe(true);
  });

  test('an unsupplied binding throws', () => {
    expect(() => check(quietFor, rows[0], { now, bindings: {} })).toThrow('quietWindow');
    expect(() => check(quietFor, rows[0], { now })).toThrow('quietWindow');
  });
});

describe('both rails classify the same rows for a bound window', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE t (id INT, "lastBreachedAt" TIMESTAMPTZ)`);
    await db.exec(
      `INSERT INTO t VALUES (1,'2026-10-06T09:00:00Z'), (2,'2026-10-06T11:00:00Z'), (3,NULL)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('check() with bindings matches toSql over bindRule', async () => {
    const bindings = { quietWindow: { ago: { hours: 2 } } };
    const inMemory = rows
      .filter((r) => check(quietFor, r, { now, bindings }) === true)
      .map((r) => r.id);
    const { sql, params } = toSql(bindRule(quietFor, bindings), { now });
    const viaSql = (
      await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
    ).rows.map((r) => r.id);
    expect(inMemory).toEqual([1]);
    expect(viaSql).toEqual(inMemory);
  });
});
