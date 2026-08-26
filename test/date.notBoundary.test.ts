import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { check, toPrisma, toSql, validateRule } from '../index';
import { getWhere } from './fixtures/helpers';

const NOW = new Date('2026-08-25T00:00:00Z');
const opts = { now: NOW };
const CUTOFF = new Date('2026-06-01T00:00:00.000Z');

// The null-carrying complements of the boundary compares. `notAfter X` is "hasn't happened
// since X, including never"; `notBefore X` is "hadn't happened by X, including never".
// Neither is onOrBefore/onOrAfter: those are positive and a null column never satisfies them.
const notAfter = { field: 'lastLoginAt', dateOperator: 'notAfter', value: '2026-06-01' };
const notBefore = { field: 'completedAt', dateOperator: 'notBefore', value: '2026-06-01' };

describe('check() — notBefore / notAfter are complements, so null matches', () => {
  test('a null column matches both', () => {
    expect(check(notAfter as never, { lastLoginAt: null }, opts)).toBe(true);
    expect(check(notAfter as never, {}, opts)).toBe(true);
    expect(check(notBefore as never, { completedAt: null }, opts)).toBe(true);
  });

  test('notAfter: on or before the point matches, after does not', () => {
    expect(check(notAfter as never, { lastLoginAt: CUTOFF }, opts)).toBe(true);
    expect(check(notAfter as never, { lastLoginAt: new Date('2026-03-01') }, opts)).toBe(true);
    expect(check(notAfter as never, { lastLoginAt: new Date('2026-08-01') }, opts)).not.toBe(true);
  });

  test('notBefore: on or after the point matches, before does not', () => {
    expect(check(notBefore as never, { completedAt: CUTOFF }, opts)).toBe(true);
    expect(check(notBefore as never, { completedAt: new Date('2026-08-01') }, opts)).toBe(true);
    expect(check(notBefore as never, { completedAt: new Date('2026-03-01') }, opts)).not.toBe(true);
  });

  test('a rolling point works: "not seen in the last 30 days, including never"', () => {
    const rule = { field: 'lastLoginAt', dateOperator: 'notAfter', value: { ago: { days: 30 } } };
    expect(check(rule as never, { lastLoginAt: null }, opts)).toBe(true);
    expect(check(rule as never, { lastLoginAt: new Date('2026-06-01') }, opts)).toBe(true);
    expect(check(rule as never, { lastLoginAt: new Date('2026-08-10') }, opts)).not.toBe(true);
  });

  test('a period anchors like its positive form: notBefore {this: month} is the start edge', () => {
    const rule = { field: 'completedAt', dateOperator: 'notBefore', value: { this: 'month' } };
    expect(check(rule as never, { completedAt: new Date('2026-08-01T00:00:00Z') }, opts)).toBe(
      true,
    );
    expect(check(rule as never, { completedAt: new Date('2026-07-31T23:00:00Z') }, opts)).not.toBe(
      true,
    );
    const after = { field: 'completedAt', dateOperator: 'notAfter', value: { this: 'month' } };
    expect(check(after as never, { completedAt: new Date('2026-08-31T23:59:59Z') }, opts)).toBe(
      true,
    );
    expect(check(after as never, { completedAt: new Date('2026-09-01T00:00:00Z') }, opts)).not.toBe(
      true,
    );
  });
});

describe('validateRule — they take exactly what before/after take', () => {
  it('accepts a literal date, a rolling point, and an edge', () => {
    expect(validateRule(notAfter as never).ok).toBe(true);
    expect(validateRule({ ...notAfter, value: { ago: { days: 30 } } } as never).ok).toBe(true);
    expect(validateRule({ ...notBefore, value: { end: { last: 'month' } } } as never).ok).toBe(
      true,
    );
  });

  it('rejects a two-item range', () => {
    expect(validateRule({ ...notAfter, value: ['2026-01-01', '2026-06-01'] } as never).ok).toBe(
      false,
    );
  });
});

describe('toSql — notBefore / notAfter keep NULL rows', () => {
  it('notAfter is <= with an IS NULL arm', () => {
    const { sql, params } = toSql(notAfter as never, opts);
    expect(sql).toBe('("lastLoginAt" <= $1 OR "lastLoginAt" IS NULL)');
    expect(params).toEqual([CUTOFF]);
  });

  it('notBefore is >= with an IS NULL arm', () => {
    expect(toSql(notBefore as never, opts).sql).toBe(
      '("completedAt" >= $1 OR "completedAt" IS NULL)',
    );
  });

  it('a same-row path compares columns and still carries the arm', () => {
    const rule = { field: 'completedAt', dateOperator: 'notAfter', path: '$.dueAt' };
    expect(toSql(rule as never, opts).sql).toBe(
      '("completedAt" <= "dueAt" OR "completedAt" IS NULL)',
    );
  });
});

const map: FieldMap = {
  models: {
    User: {
      fields: {
        lastLoginAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
        createdAt: { kind: 'scalar', type: 'DateTime', isRequired: true },
      },
    },
  },
} as never;

describe('toPrisma — the null arm rides column nullability', () => {
  const mapOpts = { map, model: 'User', now: NOW };

  it('nullable column gets the equals:null arm', () => {
    expect(getWhere(toPrisma(notAfter as never, mapOpts))).toEqual({
      OR: [{ lastLoginAt: { lte: CUTOFF } }, { lastLoginAt: { equals: null } }],
    });
    expect(getWhere(toPrisma({ ...notBefore, field: 'lastLoginAt' } as never, mapOpts))).toEqual({
      OR: [{ lastLoginAt: { gte: CUTOFF } }, { lastLoginAt: { equals: null } }],
    });
  });

  it('required column stays bare', () => {
    expect(getWhere(toPrisma({ ...notAfter, field: 'createdAt' } as never, mapOpts))).toEqual({
      createdAt: { lte: CUTOFF },
    });
  });
});

describe('NULL semantics — check() and SQL agree on every boundary operator', () => {
  let db: PGlite;
  const rows = [
    { name: 'Fresh', lastLoginAt: new Date('2026-08-10T00:00:00Z') },
    { name: 'Edge', lastLoginAt: CUTOFF },
    { name: 'Stale', lastLoginAt: new Date('2026-03-01T00:00:00Z') },
    { name: 'Never', lastLoginAt: null },
  ];
  const rules: Record<string, Condition> = Object.fromEntries(
    ['before', 'after', 'onOrBefore', 'onOrAfter', 'notBefore', 'notAfter'].map((op) => [
      op,
      { field: 'lastLoginAt', dateOperator: op, value: '2026-06-01' },
    ]),
  ) as never;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users (name TEXT, "lastLoginAt" TIMESTAMPTZ)`);
    await db.exec(
      `INSERT INTO users VALUES ('Fresh','2026-08-10T00:00:00Z'), ('Edge','2026-06-01T00:00:00Z'), ('Stale','2026-03-01T00:00:00Z'), ('Never',NULL)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  for (const [label, rule] of Object.entries(rules)) {
    it(label, async () => {
      const inMemory = rows.filter((r) => check(rule, r, opts) === true).map((r) => r.name);
      const { sql, params } = toSql(rule, opts);
      const viaSql = (
        await db.query<{ name: string }>(`SELECT name FROM users WHERE ${sql}`, params)
      ).rows.map((r) => r.name);
      expect(viaSql).toEqual(inMemory);
    });
  }

  it('notAfter is the null-carrying complement of after', async () => {
    const pick = async (rule: Condition) =>
      (
        await db.query<{ name: string }>(
          `SELECT name FROM users WHERE ${toSql(rule, opts).sql}`,
          toSql(rule, opts).params,
        )
      ).rows.map((r) => r.name);
    expect(await pick(rules.notAfter as Condition)).toEqual(['Edge', 'Stale', 'Never']);
    expect(await pick(rules.notBefore as Condition)).toEqual(['Fresh', 'Edge', 'Never']);
  });
});
