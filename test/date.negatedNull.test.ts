import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { check, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// Negation keeps NULL rows (2.19.0 ruling), including the date rail's negative-flavored
// operators: notBetween and dayNotIn.

const NOW = new Date('2026-08-25T00:00:00Z');
const opts = { now: NOW };

const notBetween = {
  field: 'lastLoginAt',
  dateOperator: 'notBetween',
  value: ['2026-01-01', '2026-06-01'],
};
const dayNotIn = { field: 'lastLoginAt', dateOperator: 'dayNotIn', value: ['monday'] };

describe('check() — a null date matches the negated date operators', () => {
  test('notBetween over a null column matches', () => {
    expect(check(notBetween as never, { lastLoginAt: null }, opts)).toBe(true);
    expect(check(notBetween as never, {}, opts)).toBe(true);
  });

  test('dayNotIn over a null column matches', () => {
    expect(check(dayNotIn as never, { lastLoginAt: null }, opts)).toBe(true);
    expect(check(dayNotIn as never, {}, opts)).toBe(true);
  });

  test('a null match is true, not the rule error', () => {
    expect(
      check({ ...notBetween, error: 'in the window' } as never, { lastLoginAt: null }, opts),
    ).toBe(true);
  });

  test('a real value still compares instead of taking the null arm', () => {
    expect(check(notBetween as never, { lastLoginAt: new Date('2026-03-01') }, opts)).not.toBe(
      true,
    );
    expect(check(notBetween as never, { lastLoginAt: new Date('2026-07-01') }, opts)).toBe(true);
    expect(check(notBetween as never, { lastLoginAt: 0 }, opts)).toBe(true);
  });

  test("'' is still malformed data, not absence", () => {
    expect(() => check(notBetween as never, { lastLoginAt: '' }, opts)).toThrow(
      'is not a valid date',
    );
  });
});

describe('toSql — negated date operators keep NULL rows', () => {
  it('notBetween ORs an IS NULL arm', () => {
    const { sql } = toSql(notBetween as never);
    expect(sql).toBe('("lastLoginAt" NOT BETWEEN $1 AND $2 OR "lastLoginAt" IS NULL)');
  });

  it('dayNotIn ORs an IS NULL arm', () => {
    const { sql } = toSql(dayNotIn as never);
    expect(sql).toBe('(EXTRACT(DOW FROM "lastLoginAt") <> ALL($1) OR "lastLoginAt" IS NULL)');
  });

  it('the positive forms stay bare', () => {
    expect(
      toSql({
        field: 'lastLoginAt',
        dateOperator: 'between',
        value: ['2026-01-01', '2026-06-01'],
      } as never).sql,
    ).toBe('"lastLoginAt" BETWEEN $1 AND $2');
    expect(
      toSql({ field: 'lastLoginAt', dateOperator: 'dayIn', value: ['monday'] } as never).sql,
    ).toBe('EXTRACT(DOW FROM "lastLoginAt") = ANY($1)');
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

describe('toPrisma — notBetween keeps NULL rows when the map licenses the arm', () => {
  const mapOpts = { map, model: 'User', now: NOW };
  const range = {
    gte: new Date('2026-01-01T00:00:00.000Z'),
    lte: new Date('2026-06-01T00:00:00.000Z'),
  };

  it('nullable column gets the equals:null arm', () => {
    expect(getWhere(toPrisma(notBetween as never, mapOpts))).toEqual({
      OR: [{ lastLoginAt: { NOT: range } }, { lastLoginAt: { equals: null } }],
    });
  });

  it('required column stays bare', () => {
    expect(getWhere(toPrisma({ ...notBetween, field: 'createdAt' } as never, mapOpts))).toEqual({
      createdAt: { NOT: range },
    });
  });

  it('no map stays bare (nullability unknown)', () => {
    expect(getWhere(toPrisma(notBetween as never, { now: NOW }))).toEqual({
      lastLoginAt: { NOT: range },
    });
  });
});

describe('NULL date semantics — check() and SQL agree on every date operator', () => {
  let db: PGlite;

  const rows = [
    { name: 'Alice', lastLoginAt: new Date('2026-03-02T12:00:00Z') },
    { name: 'Bob', lastLoginAt: null },
  ];

  const rules: Record<string, Condition> = {
    before: { field: 'lastLoginAt', dateOperator: 'before', value: '2026-06-01' },
    after: { field: 'lastLoginAt', dateOperator: 'after', value: '2026-06-01' },
    onOrBefore: { field: 'lastLoginAt', dateOperator: 'onOrBefore', value: '2026-06-01' },
    onOrAfter: { field: 'lastLoginAt', dateOperator: 'onOrAfter', value: '2026-06-01' },
    between: { field: 'lastLoginAt', dateOperator: 'between', value: ['2026-01-01', '2026-06-01'] },
    notBetween: {
      field: 'lastLoginAt',
      dateOperator: 'notBetween',
      value: ['2026-01-01', '2026-06-01'],
    },
    dayIn: { field: 'lastLoginAt', dateOperator: 'dayIn', value: ['monday'] },
    dayNotIn: { field: 'lastLoginAt', dateOperator: 'dayNotIn', value: ['monday'] },
  } as never;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users (name TEXT, "lastLoginAt" TIMESTAMPTZ)`);
    await db.exec(`INSERT INTO users VALUES ('Alice','2026-03-02T12:00:00Z'), ('Bob',NULL)`);
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
});
