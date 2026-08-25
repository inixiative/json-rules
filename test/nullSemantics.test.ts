import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { check, Operator, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

const rows = [
  { name: 'Alice', company: 'acme', score: 10 },
  { name: 'Bob', company: null, score: null },
];

const rules: Record<string, Condition> = {
  'equals acme': { field: 'company', operator: Operator.equals, value: 'acme' },
  'notEquals acme': { field: 'company', operator: Operator.notEquals, value: 'acme' },
  'equals null': { field: 'company', operator: Operator.equals, value: null },
  'notEquals null': { field: 'company', operator: Operator.notEquals, value: null },
  'in [acme]': { field: 'company', operator: Operator.in, value: ['acme'] },
  'notIn [acme]': { field: 'company', operator: Operator.notIn, value: ['acme'] },
  'in [null]': { field: 'company', operator: Operator.in, value: [null] },
  'in [acme, null]': { field: 'company', operator: Operator.in, value: ['acme', null] },
  'notIn [acme, null]': { field: 'company', operator: Operator.notIn, value: ['acme', null] },
  'contains ac': { field: 'company', operator: Operator.contains, value: 'ac' },
  'notContains ac': { field: 'company', operator: Operator.notContains, value: 'ac' },
  'notContains ac ci': {
    field: 'company',
    operator: Operator.notContains,
    value: 'AC',
    caseInsensitive: true,
  },
  'startsWith ac': { field: 'company', operator: Operator.startsWith, value: 'ac' },
  'matches ^ac': { field: 'company', operator: Operator.matches, value: '^ac' },
  'notMatches ^ac': { field: 'company', operator: Operator.notMatches, value: '^ac' },
  'lessThan 5': { field: 'score', operator: Operator.lessThan, value: 5 },
  'greaterThan 5': { field: 'score', operator: Operator.greaterThan, value: 5 },
  'between [0,5]': { field: 'score', operator: Operator.between, value: [0, 5] },
  'notBetween [0,5]': { field: 'score', operator: Operator.notBetween, value: [0, 5] },
  isEmpty: { field: 'company', operator: Operator.isEmpty },
  notEmpty: { field: 'company', operator: Operator.notEmpty },
  exists: { field: 'company', operator: Operator.exists },
  notExists: { field: 'company', operator: Operator.notExists },
};

describe('NULL semantics — check() and toSql agree on every operator', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE users (name TEXT, company TEXT, score INT)`);
    await db.exec(`INSERT INTO users VALUES ('Alice','acme',10), ('Bob',NULL,NULL)`);
  });

  afterAll(async () => {
    await db.close();
  });

  for (const [label, rule] of Object.entries(rules)) {
    it(label, async () => {
      const inMemory = rows.filter((r) => check(rule, r) === true).map((r) => r.name);
      const { sql, params } = toSql(rule);
      const viaSql = (
        await db.query<{ name: string }>(`SELECT name FROM users WHERE ${sql}`, params)
      ).rows.map((r) => r.name);
      expect(viaSql).toEqual(inMemory);
    });
  }
});

describe('NULL semantics — toSql shapes', () => {
  it('notEquals keeps NULL rows', () => {
    const { sql } = toSql({ field: 'role', operator: Operator.notEquals, value: 'guest' });
    expect(sql).toBe('("role" <> $1 OR "role" IS NULL)');
  });

  it('notIn keeps NULL rows', () => {
    const { sql } = toSql({ field: 'role', operator: Operator.notIn, value: ['a', 'b'] });
    expect(sql).toBe('("role" <> ALL($1) OR "role" IS NULL)');
  });

  it('in with a null member matches NULL rows', () => {
    const { sql, params } = toSql({ field: 'role', operator: Operator.in, value: ['a', null] });
    expect(sql).toBe('("role" = ANY($1) OR "role" IS NULL)');
    expect(params).toEqual([['a']]);
  });

  it('in with only null matches NULL rows', () => {
    const { sql, params } = toSql({ field: 'role', operator: Operator.in, value: [null] });
    expect(sql).toBe('"role" IS NULL');
    expect(params).toEqual([]);
  });

  it('notIn with a null member excludes NULL rows', () => {
    const { sql, params } = toSql({ field: 'role', operator: Operator.notIn, value: ['a', null] });
    expect(sql).toBe('("role" <> ALL($1) AND "role" IS NOT NULL)');
    expect(params).toEqual([['a']]);
  });

  it('notContains keeps NULL rows', () => {
    const { sql } = toSql({ field: 'email', operator: Operator.notContains, value: 'spam' });
    expect(sql).toBe('("email" NOT LIKE $1 OR "email" IS NULL)');
  });

  it('notMatches keeps NULL rows', () => {
    const { sql } = toSql({ field: 'code', operator: Operator.notMatches, value: '^X' });
    expect(sql).toBe('("code" !~ $1 OR "code" IS NULL)');
  });

  it('notBetween keeps NULL rows', () => {
    const { sql } = toSql({ field: 'score', operator: Operator.notBetween, value: [0, 10] });
    expect(sql).toBe('("score" NOT BETWEEN $1 AND $2 OR "score" IS NULL)');
  });

  it('column-to-column equals treats two NULLs as equal, like check()', () => {
    const { sql } = toSql({ field: 'a', operator: Operator.equals, path: '$.b' });
    expect(sql).toBe('"a" IS NOT DISTINCT FROM "b"');
  });

  it('column-to-column notEquals keeps a NULL side, like check()', () => {
    const { sql } = toSql({ field: 'a', operator: Operator.notEquals, path: '$.b' });
    expect(sql).toBe('"a" IS DISTINCT FROM "b"');
  });
});

const map: FieldMap = {
  models: {
    User: {
      fields: {
        role: { kind: 'scalar', type: 'String', isRequired: true },
        company: { kind: 'scalar', type: 'String', isRequired: false },
        score: { kind: 'scalar', type: 'Int', isRequired: false },
        profile: { kind: 'object', type: 'Profile' },
      },
    },
    Profile: {
      fields: {
        bio: { kind: 'scalar', type: 'String', isRequired: false },
      },
    },
  },
};

describe('NULL semantics — toPrisma adds a null arm on nullable columns', () => {
  const opts = { map, model: 'User' };

  it('notEquals on a nullable column keeps NULL rows', () => {
    expect(
      getWhere(toPrisma({ field: 'company', operator: Operator.notEquals, value: 'acme' }, opts)),
    ).toEqual({ OR: [{ company: { not: 'acme' } }, { company: { equals: null } }] });
  });

  it('notEquals on a required column stays bare', () => {
    expect(
      getWhere(toPrisma({ field: 'role', operator: Operator.notEquals, value: 'guest' }, opts)),
    ).toEqual({ role: { not: 'guest' } });
  });

  it('notEquals without a map stays bare (nullability unknown)', () => {
    expect(
      getWhere(toPrisma({ field: 'role', operator: Operator.notEquals, value: 'guest' })),
    ).toEqual({ role: { not: 'guest' } });
  });

  it('notEquals null is already an IS NOT NULL — no arm', () => {
    expect(
      getWhere(toPrisma({ field: 'company', operator: Operator.notEquals, value: null }, opts)),
    ).toEqual({ company: { not: null } });
  });

  it('notIn on a nullable column keeps NULL rows', () => {
    expect(
      getWhere(toPrisma({ field: 'company', operator: Operator.notIn, value: ['acme'] }, opts)),
    ).toEqual({ OR: [{ company: { notIn: ['acme'] } }, { company: { equals: null } }] });
  });

  it('in with a null member matches NULL rows', () => {
    expect(
      getWhere(toPrisma({ field: 'company', operator: Operator.in, value: ['acme', null] }, opts)),
    ).toEqual({ OR: [{ company: { in: ['acme'] } }, { company: { equals: null } }] });
  });

  it('notIn with a null member excludes NULL rows', () => {
    expect(
      getWhere(
        toPrisma({ field: 'company', operator: Operator.notIn, value: ['acme', null] }, opts),
      ),
    ).toEqual({ AND: [{ company: { notIn: ['acme'] } }, { company: { not: null } }] });
  });

  it('notContains on a nullable column keeps NULL rows', () => {
    expect(
      getWhere(toPrisma({ field: 'company', operator: Operator.notContains, value: 'ac' }, opts)),
    ).toEqual({
      OR: [{ company: { not: { contains: 'ac' } } }, { company: { equals: null } }],
    });
  });

  it('notBetween on a nullable column keeps NULL rows', () => {
    expect(
      getWhere(toPrisma({ field: 'score', operator: Operator.notBetween, value: [0, 5] }, opts)),
    ).toEqual({ OR: [{ score: { NOT: { gte: 0, lte: 5 } } }, { score: { equals: null } }] });
  });

  it('walks a relation path to the leaf column', () => {
    expect(
      getWhere(toPrisma({ field: 'profile.bio', operator: Operator.notEquals, value: 'x' }, opts)),
    ).toEqual({
      OR: [{ profile: { bio: { not: 'x' } } }, { profile: { bio: { equals: null } } }],
    });
  });
});

describe('NULL semantics — exists is IS NOT NULL in check()', () => {
  it('exists is false for null', () => {
    expect(check({ field: 'a', operator: Operator.exists }, { a: null })).toBe('a must exist');
  });

  it('notExists is true for null', () => {
    expect(check({ field: 'a', operator: Operator.notExists }, { a: null })).toBe(true);
  });
});
