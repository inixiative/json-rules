import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { check, toPrisma, toSql, validateRule } from '../index';
import { getWhere } from './fixtures/helpers';

const NOW = new Date('2026-08-25T00:00:00Z');
const opts = { now: NOW };

// "hasn't been seen in the last 30 days" — the complement of `within`, so a never-set
// date is not in the window and matches (negation ruling), on every rail.
const notWithin = { field: 'lastLoginAt', dateOperator: 'notWithin', value: { ago: { days: 30 } } };
const within = { field: 'lastLoginAt', dateOperator: 'within', value: { ago: { days: 30 } } };

describe('check() — notWithin is the complement of within', () => {
  test('a null column matches', () => {
    expect(check(notWithin as never, { lastLoginAt: null }, opts)).toBe(true);
    expect(check(notWithin as never, {}, opts)).toBe(true);
  });

  test('inside the window is a non-match, outside matches', () => {
    const inside = { lastLoginAt: new Date('2026-08-10T00:00:00Z') };
    const outside = { lastLoginAt: new Date('2026-06-01T00:00:00Z') };
    expect(check(notWithin as never, inside, opts)).not.toBe(true);
    expect(check(notWithin as never, outside, opts)).toBe(true);
    expect(check(within as never, inside, opts)).toBe(true);
    expect(check(within as never, outside, opts)).not.toBe(true);
  });

  test('the window edges belong to within, not notWithin', () => {
    expect(check(notWithin as never, { lastLoginAt: NOW }, opts)).not.toBe(true);
    expect(
      check(notWithin as never, { lastLoginAt: new Date('2026-07-26T00:00:00Z') }, opts),
    ).not.toBe(true);
  });

  test('a period range works the same ("not this month")', () => {
    const rule = { field: 'lastLoginAt', dateOperator: 'notWithin', value: { this: 'month' } };
    expect(check(rule as never, { lastLoginAt: new Date('2026-08-03T00:00:00Z') }, opts)).not.toBe(
      true,
    );
    expect(check(rule as never, { lastLoginAt: new Date('2026-07-03T00:00:00Z') }, opts)).toBe(
      true,
    );
  });
});

describe('validateRule — notWithin takes exactly what within takes', () => {
  it('accepts a rolling or period range', () => {
    expect(validateRule(notWithin as never).ok).toBe(true);
    expect(validateRule({ ...notWithin, value: { last: 'week' } } as never).ok).toBe(true);
  });

  it('rejects a literal date and a start/end edge', () => {
    expect(validateRule({ ...notWithin, value: '2026-01-01' } as never).ok).toBe(false);
    expect(validateRule({ ...notWithin, value: { end: { last: 'month' } } } as never).ok).toBe(
      false,
    );
  });
});

describe('toSql — notWithin keeps NULL rows', () => {
  it('negates BETWEEN and ORs an IS NULL arm', () => {
    const { sql, params } = toSql(notWithin as never, opts);
    expect(sql).toBe('("lastLoginAt" NOT BETWEEN $1 AND $2 OR "lastLoginAt" IS NULL)');
    expect(params).toEqual([new Date('2026-07-26T00:00:00.000Z'), NOW]);
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

describe('toPrisma — notWithin keeps NULL rows when the map licenses the arm', () => {
  const mapOpts = { map, model: 'User', now: NOW };
  const window = { gte: new Date('2026-07-26T00:00:00.000Z'), lte: NOW };

  it('nullable column gets the equals:null arm', () => {
    expect(getWhere(toPrisma(notWithin as never, mapOpts))).toEqual({
      OR: [{ lastLoginAt: { NOT: window } }, { lastLoginAt: { equals: null } }],
    });
  });

  it('required column stays bare', () => {
    expect(getWhere(toPrisma({ ...notWithin, field: 'createdAt' } as never, mapOpts))).toEqual({
      createdAt: { NOT: window },
    });
  });
});

describe('NULL semantics — check() and SQL agree on notWithin', () => {
  let db: PGlite;
  const rows = [
    { name: 'Fresh', lastLoginAt: new Date('2026-08-10T00:00:00Z') },
    { name: 'Stale', lastLoginAt: new Date('2026-06-01T00:00:00Z') },
    { name: 'Never', lastLoginAt: null },
  ];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users (name TEXT, "lastLoginAt" TIMESTAMPTZ)`);
    await db.exec(
      `INSERT INTO users VALUES ('Fresh','2026-08-10T00:00:00Z'), ('Stale','2026-06-01T00:00:00Z'), ('Never',NULL)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  for (const [label, rule] of Object.entries({ within, notWithin }) as [string, Condition][]) {
    it(label, async () => {
      const inMemory = rows.filter((r) => check(rule, r, opts) === true).map((r) => r.name);
      const { sql, params } = toSql(rule, opts);
      const viaSql = (
        await db.query<{ name: string }>(`SELECT name FROM users WHERE ${sql}`, params)
      ).rows.map((r) => r.name);
      expect(viaSql).toEqual(inMemory);
      if (label === 'notWithin') expect(inMemory).toEqual(['Stale', 'Never']);
    });
  }
});
