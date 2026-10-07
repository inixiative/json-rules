import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { bindingNames, check, resolveBindings, toPrisma, toSql, validateRule } from '../index';
import { getWhere } from './fixtures/helpers';

// Where a value source reads nothing, check(), executed SQL and the Prisma filter agree.

const rule = (r: object): Condition => r as never;
const NOW = new Date('2026-10-06T00:00:00Z');

type Row = { id: number; a: number | null };
const rows: Row[] = [
  { id: 1, a: 3 },
  { id: 2, a: null },
  { id: 3, a: 8 },
];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE t (id INT, a INT)');
  for (const r of rows) await db.query('INSERT INTO t VALUES ($1, $2)', [r.id, r.a]);
});
afterAll(async () => {
  await db.close();
});

const both = async (condition: Condition, expected: number[], context = {}) => {
  const inMemory = rows.filter((r) => check(condition, r, { context }) === true).map((r) => r.id);
  const { sql, params } = toSql(condition, { context });
  const viaSql = (
    await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
  ).rows.map((r) => r.id);
  expect(inMemory).toEqual(expected);
  expect(viaSql).toEqual(expected);
};

describe('an ordered comparison that reads nothing matches nothing', () => {
  test('missing and null context paths', async () => {
    const r = rule({ field: 'a', operator: 'lessThan', path: 'x' });
    await both(r, [], {});
    await both(r, [], { x: null });
    expect(getWhere(toPrisma(r, { context: {} }))).toEqual({ OR: [] });
  });
});

describe('a missing context path reads as null, the is-null sentinel', () => {
  test('equals and notEquals', async () => {
    await both(rule({ field: 'a', operator: 'equals', path: 'x' }), [2], {});
    await both(rule({ field: 'a', operator: 'notEquals', path: 'x' }), [1, 3], {});
    expect(
      getWhere(toPrisma(rule({ field: 'a', operator: 'equals', path: 'x' }), { context: {} })),
    ).toEqual({
      a: { equals: null },
    });
  });
});

describe('a field range with a missing end matches nothing', () => {
  test('between and notBetween', async () => {
    await both(rule({ field: 'a', operator: 'between', value: [5, null] }), []);
    await both(rule({ field: 'a', operator: 'notBetween', value: [5, null] }), [2]);
    expect(getWhere(toPrisma(rule({ field: 'a', operator: 'between', value: [5, null] })))).toEqual(
      {
        OR: [],
      },
    );
  });
});

describe('caseInsensitive leaves offset arithmetic alone', () => {
  test('equals with an offset', async () => {
    await both(
      rule({
        field: 'a',
        operator: 'equals',
        value: 2,
        offset: { value: 1 },
        caseInsensitive: true,
      }),
      [1],
    );
  });
});

describe('a missing zone bind throws whatever the row holds', () => {
  test('a null field', () => {
    expect(() =>
      check(
        rule({ field: 'ts', dateOperator: 'before', value: '2026-01-01' }),
        { ts: null },
        {
          timeZone: { bind: 'tz' },
        },
      ),
    ).toThrow('Missing binding for "tz"');
  });
});

describe('a bind inside a bound value', () => {
  test('resolveBindings resolves what the substitution brought in', () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'after',
      path: 'anchor',
      offset: { bind: 'o' },
    });
    const resolved = resolveBindings(r, { o: { ago: { days: { bind: 'k' } } }, k: 2 });
    expect(resolved).toEqual(
      rule({
        field: 'ts',
        dateOperator: 'after',
        path: 'anchor',
        offset: { value: { ago: { days: { value: 2 } } } },
      }),
    );
    expect([...bindingNames(resolved)]).toEqual([]);
  });
});

describe('validateRule refuses a row-read range for toSql', () => {
  test('field between and date within', () => {
    const codes = (r: object) =>
      validateRule(rule(r), { target: 'toSql' }).errors.map((e) => e.code);
    expect(codes({ field: 'a', operator: 'between', path: '$.b' })).toEqual([
      'unsupported_sql_path',
    ]);
    expect(codes({ field: 'ts', dateOperator: 'within', path: '$.w' })).toEqual([
      'unsupported_sql_path',
    ]);
    expect(codes({ field: 'a', operator: 'between', path: 'range' })).toEqual([]);
  });
});

describe('a $. value path walks relations like a field', () => {
  const map: FieldMap = {
    models: {
      Incident: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          lastBreachedAt: { kind: 'scalar', type: 'DateTime' },
          ruleId: { kind: 'scalar', type: 'Int' },
          rule: { kind: 'object', type: 'Rule', fromFields: ['ruleId'], toFields: ['id'] },
        },
      },
      Rule: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          windowSeconds: { kind: 'scalar', type: 'Int' },
        },
      },
    },
  } as never;

  test('the Zealot auto-resolve guard compiles and runs', async () => {
    const pg = new PGlite();
    await pg.exec(`SET TIME ZONE 'UTC';
      CREATE TABLE "Rule" (id INT, "windowSeconds" INT);
      CREATE TABLE "Incident" (id INT, "lastBreachedAt" TIMESTAMPTZ, "ruleId" INT);
      INSERT INTO "Rule" VALUES (1, 3600), (2, 86400);
      INSERT INTO "Incident" VALUES
        (1, '2026-10-05T22:00:00Z', 1), (2, '2026-10-05T22:00:00Z', 2), (3, '2026-10-05T23:30:00Z', 1);`);
    const guard = rule({
      field: 'lastBreachedAt',
      dateOperator: 'before',
      value: { ago: { seconds: { path: '$.rule.windowSeconds' } } },
    });
    const { sql, params, joins } = toSql(guard, { map, model: 'Incident', now: NOW });
    const ids = (
      await pg.query<{ id: number }>(
        `SELECT t0.id FROM "Incident" t0 ${joins.join(' ')} WHERE ${sql} ORDER BY t0.id`,
        params,
      )
    ).rows.map((r) => r.id);
    await pg.close();
    const inMemory = [
      { id: 1, lastBreachedAt: '2026-10-05T22:00:00Z', rule: { windowSeconds: 3600 } },
      { id: 2, lastBreachedAt: '2026-10-05T22:00:00Z', rule: { windowSeconds: 86400 } },
      { id: 3, lastBreachedAt: '2026-10-05T23:30:00Z', rule: { windowSeconds: 3600 } },
    ]
      .filter((r) => check(guard, r, { now: NOW }) === true)
      .map((r) => r.id);
    expect(ids).toEqual([1]);
    expect(inMemory).toEqual([1]);
  });
});
