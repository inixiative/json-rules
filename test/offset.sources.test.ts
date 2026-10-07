import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { bindRule, check, listBindings, toPrisma, toSql } from '../index';
import { createLens } from '../src/lens/createLens';
import { describeRule } from '../src/lens/describeRule';
import { getWhere } from './fixtures/helpers';

// An offset is a value source of its own — `{ value }`, `{ path }` or `{ bind }` (with
// `bindOptional`) — read with the comparison value's contract.

const rule = (r: object): Condition => r as never;
const NOW = new Date('2026-10-06T00:00:00Z');

type Row = { id: number; score: number | null; par: number | null; handicap: number | null };

// Net score at or under par: gross <= par + handicap.
const golfers: Row[] = [
  { id: 1, score: 80, par: 72, handicap: 10 },
  { id: 2, score: 85, par: 72, handicap: 10 },
  { id: 3, score: 80, par: 72, handicap: null },
];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE t (id INT, score INT, par INT, handicap INT)');
  for (const r of golfers)
    await db.query('INSERT INTO t VALUES ($1, $2, $3, $4)', [r.id, r.score, r.par, r.handicap]);
});
afterAll(async () => {
  await db.close();
});

type Opts = { context?: Record<string, unknown>; bindings?: Record<string, unknown> };

const bothRails = async (condition: Condition, expected: number[], opts: Opts = {}) => {
  const inMemory = golfers
    .filter((r) => check(condition, r, { now: NOW, ...opts } as never) === true)
    .map((r) => r.id);
  const compiled = opts.bindings ? bindRule(condition, opts.bindings as never) : condition;
  const { sql, params } = toSql(compiled, { now: NOW, context: opts.context });
  const viaSql = (
    await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
  ).rows.map((r) => r.id);
  expect(inMemory).toEqual(expected);
  expect(viaSql).toEqual(expected);
};

describe('a numeric offset from each source', () => {
  test('row path: a golf handicap', async () => {
    await bothRails(
      rule({
        field: 'score',
        operator: 'lessThanEquals',
        path: '$.par',
        offset: { path: '$.handicap' },
      }),
      [1],
    );
  });

  test('bind', async () => {
    await bothRails(
      rule({
        field: 'score',
        operator: 'lessThanEquals',
        path: '$.par',
        offset: { bind: 'strokes' },
      }),
      [1, 3],
      { bindings: { strokes: 10 } },
    );
  });

  test('a bound comparison value and a bound offset', async () => {
    await bothRails(
      rule({
        field: 'score',
        operator: 'lessThanEquals',
        bind: 'par',
        offset: { bind: 'strokes' },
      }),
      [1, 2, 3],
      { bindings: { par: 72, strokes: 13 } },
    );
  });

  test('value plus offset', async () => {
    await bothRails(
      rule({ field: 'score', operator: 'lessThanEquals', value: 72, offset: { value: 8 } }),
      [1, 3],
    );
  });

  test('an unsupplied optional offset bind fails closed', async () => {
    await bothRails(
      rule({
        field: 'score',
        operator: 'lessThanEquals',
        path: '$.par',
        offset: { bind: 'strokes', bindOptional: true },
      }),
      [],
      { bindings: {} },
    );
  });

  test('an unsupplied required offset bind throws on every rail', () => {
    const r = rule({
      field: 'score',
      operator: 'lessThanEquals',
      path: '$.par',
      offset: { bind: 'strokes' },
    });
    expect(() => check(r, golfers[0], { bindings: {} })).toThrow('Missing binding for "strokes"');
    expect(() => toSql(r)).toThrow('Unresolved binding');
    expect(() =>
      toPrisma({ ...(r as object), path: 'par' } as never, { context: { par: 72 } }),
    ).toThrow('Unresolved binding');
  });
});

describe('bindings see an offset bind', () => {
  const r = rule({
    all: [
      { field: 'score', operator: 'lessThanEquals', bind: 'par', offset: { bind: 'strokes' } },
      {
        field: 'score',
        operator: 'greaterThan',
        path: '$.par',
        offset: { bind: 'floor', bindOptional: true },
      },
    ],
  });

  test('listBindings and requiredBindings', () => {
    expect(listBindings(r).sort()).toEqual(['floor', 'par', 'strokes']);
    expect(listBindings(r, { required: true }).sort()).toEqual(['par', 'strokes']);
  });

  test('bindRule turns a bound offset into a value', () => {
    expect(bindRule(r, { par: 72, strokes: 10 })).toEqual(
      rule({
        all: [
          { field: 'score', operator: 'lessThanEquals', value: 72, offset: { value: 10 } },
          {
            field: 'score',
            operator: 'greaterThan',
            path: '$.par',
            offset: { bind: 'floor', bindOptional: true },
          },
        ],
      }),
    );
  });
});

describe('a date offset from each source', () => {
  const d = (iso: string) => new Date(iso);
  const ts = { ts: d('2026-10-05T00:00:00Z') };

  test('value on an edge: the fifth of this month', () => {
    const fifth = rule({
      field: 'ts',
      dateOperator: 'onOrAfter',
      value: { start: { this: 'month' } },
      offset: { value: { ahead: { days: 4 } } },
    });
    expect(check(fifth, ts, { now: NOW })).toBe(true);
    expect(check(fifth, { ts: d('2026-10-04T00:00:00Z') }, { now: NOW })).not.toBe(true);
    expect(getWhere(toPrisma(fifth, { now: NOW }))).toEqual({
      ts: { gte: d('2026-10-05T00:00:00Z') },
    });
    expect(toSql(fifth, { now: NOW }).params).toEqual([d('2026-10-05T00:00:00Z')]);
  });

  test('bind', () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'before',
      path: 'anchor',
      offset: { bind: 'grace' },
    });
    const opts = {
      context: { anchor: '2026-10-10T00:00:00Z' },
      bindings: { grace: { ago: { days: 3 } } },
    };
    expect(check(r, ts, opts)).toBe(true);
    expect(check(r, { ts: d('2026-10-08T00:00:00Z') }, opts)).not.toBe(true);
    expect(getWhere(toPrisma(bindRule(r, opts.bindings), { context: opts.context }))).toEqual({
      ts: { lt: d('2026-10-07T00:00:00Z') },
    });
  });

  test('context path', () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'before',
      path: 'anchor',
      offset: { path: 'grace' },
    });
    const context = { anchor: '2026-10-10T00:00:00Z', grace: { ago: { days: 3 } } };
    expect(check(r, ts, { context })).toBe(true);
    expect(toSql(r, { context }).params).toEqual([d('2026-10-07T00:00:00Z')]);
  });

  test('a row path is check-only', () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'before',
      value: '2026-10-10T00:00:00Z',
      offset: { path: '$.grace' },
    });
    expect(check(r, { ...ts, grace: { ago: { days: 3 } } })).toBe(true);
    expect(() => toSql(r)).toThrow('check()');
    expect(() => toPrisma(r)).toThrow('toPrisma');
  });

  test('an offset that reads something other than ago / ahead throws', () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'before',
      path: 'anchor',
      offset: { bind: 'grace' },
    });
    expect(() =>
      check(r, ts, { context: { anchor: '2026-10-10T00:00:00Z' }, bindings: { grace: 3 } }),
    ).toThrow('ago');
  });

  test('describeRule: a row date-offset path keeps check only', () => {
    const map: FieldMap = {
      models: {
        E: {
          fields: {
            ts: { kind: 'scalar', type: 'DateTime' },
            grace: { kind: 'scalar', type: 'Json' },
          },
        },
      },
    };
    const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'E' });
    expect(
      describeRule(
        rule({
          field: 'ts',
          dateOperator: 'before',
          value: '2026-10-10',
          offset: { path: '$.grace' },
        }),
        lens,
      ).supportedTargets,
    ).toEqual(['check']);
  });
});
