import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, Lens } from '../index';
import {
  ArrayOperator,
  check,
  coerceRule,
  DateOperator,
  Operator,
  toSql,
  validateRuleInLens,
} from '../index';

// The field-kind gate must track what the rails actually do: a rule it accepts runs on
// Postgres and agrees with check(); a rule it rejects is one Postgres cannot run. (Postgres
// infers untyped parameters, so some rejected literals — `name = 123` — execute there; Prisma's
// input validation is the rail that refuses those, and the unit tests cover them.)

const lens: Lens = {
  maps: {
    db: {
      models: {
        events: {
          fields: {
            name: { kind: 'scalar', type: 'String' },
            count: { kind: 'scalar', type: 'Int' },
            active: { kind: 'scalar', type: 'Boolean' },
            createdAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
          },
        },
      },
    },
  },
  mapName: 'db',
  model: 'events',
};

const rows = [
  { name: 'a', count: 1, active: true, createdAt: '2026-09-01T10:00:00.000Z' },
  { name: 'b', count: 2, active: false, createdAt: null },
];

const now = new Date('2026-09-30T00:00:00Z');

const accepted: Record<string, Condition> = {
  'day-only date on a DateTime field': {
    field: 'createdAt',
    operator: Operator.greaterThan,
    value: '2026-08-01',
  },
  'ISO date in a list': {
    field: 'createdAt',
    operator: Operator.in,
    value: ['2026-09-01T10:00:00Z'],
  },
  'epoch-ms on a DateTime field': {
    field: 'createdAt',
    operator: Operator.lessThan,
    value: 1_790_000_000_000,
  },
  'null on a DateTime field': { field: 'createdAt', operator: Operator.equals, value: null },
  'relative date': {
    field: 'createdAt',
    dateOperator: DateOperator.after,
    value: { ago: { days: 60 } },
  },
  'Int range': { field: 'count', operator: Operator.between, value: [1, 10] },
  'Int notIn with null': { field: 'count', operator: Operator.notIn, value: [1, null] },
  'Boolean literal': { field: 'active', operator: Operator.notEquals, value: false },
  'String contains': { field: 'name', operator: Operator.contains, value: 'a' },
};

const rejected: Record<string, Condition> = {
  'contains on a DateTime field': { field: 'createdAt', operator: Operator.contains, value: 'abc' },
  'unparseable date literal': {
    field: 'createdAt',
    operator: Operator.equals,
    value: 'not-a-date',
  },
  'fraction on an Int field': { field: 'count', operator: Operator.lessThan, value: 1.5 },
};

describe('field-kind gate vs executed SQL (PGlite)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      `CREATE TABLE events (name TEXT, count INT, active BOOLEAN, "createdAt" TIMESTAMPTZ)`,
    );
    await db.exec(
      `INSERT INTO events VALUES ('a', 1, true, '2026-09-01T10:00:00Z'), ('b', 2, false, NULL)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const runSql = async (rule: Condition) => {
    const { sql, params } = toSql(rule, { now });
    return (
      await db.query<{ name: string }>(`SELECT name FROM events WHERE ${sql}`, params)
    ).rows.map((r) => r.name);
  };

  for (const [label, raw] of Object.entries(accepted)) {
    it(`accepted, runs, agrees with check(): ${label}`, async () => {
      expect(validateRuleInLens(raw, lens).ok).toBe(true);
      const rule = coerceRule(raw, lens);
      const inMemory = rows.filter((r) => check(rule, r, { now }) === true).map((r) => r.name);
      expect(await runSql(rule)).toEqual(inMemory);
    });
  }

  for (const [label, raw] of Object.entries(rejected)) {
    it(`rejected, and Postgres cannot run it: ${label}`, async () => {
      expect(validateRuleInLens(raw, lens).ok).toBe(false);
      await expect(runSql(coerceRule(raw, lens))).rejects.toThrow();
    });
  }

  it('an array operator on a non-list is rejected, and check() cannot iterate it', () => {
    const rule: Condition = {
      field: 'name',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'x', operator: Operator.equals, value: 1 },
    };
    expect(validateRuleInLens(rule, lens).ok).toBe(false);
    expect(() => check(rule, rows[0])).toThrow('name must be an array');
  });
});
