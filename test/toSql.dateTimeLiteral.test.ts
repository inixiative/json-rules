import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { check } from '../src/check';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';
import type { Condition } from '../src/types';

// The toSql twin of test/toPrisma.dateTimeLiteral.test.ts. Postgres casts an untyped string
// parameter itself, but it reads a zoneless one in the SESSION's zone, while check() anchors it
// in UTC. The literal now compiles to a Date (an instant), so the rails agree whatever the
// session zone — the differential below runs in America/New_York to prove it.
const map: FieldMap = {
  models: {
    events: {
      fields: {
        name: { kind: 'scalar', type: 'String' },
        createdAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
      },
    },
  },
};
const opts = { map, model: 'events' };

describe('toSql — DateTime field-operator literals compile to Dates', () => {
  it('a day-only literal becomes a Date param', () => {
    const { params } = toSql(
      { field: 'createdAt', operator: Operator.greaterThan, value: '2026-09-01' },
      opts,
    );
    expect(params).toEqual([new Date('2026-09-01T00:00:00Z')]);
  });

  it('a coerceType that overrides the column kind throws', () => {
    expect(() =>
      toSql({ field: 'name', operator: Operator.greaterThan, value: 5, coerceType: 'Int' }, opts),
    ).toThrow(
      "coerceType 'Int' overrides String field 'name', but toSql compares the column as stored",
    );
  });

  it('an unparseable literal throws at compile time', () => {
    expect(() =>
      toSql({ field: 'createdAt', operator: Operator.equals, value: 'not-a-date' }, opts),
    ).toThrow("Invalid date value for DateTime field 'createdAt': not-a-date");
  });
});

describe('toSql DateTime literals vs check() in a non-UTC session (PGlite)', () => {
  let db: PGlite;

  const rows = [
    { name: 'early', createdAt: '2026-09-01T02:00:00.000Z' },
    { name: 'late', createdAt: '2026-09-01T10:00:00.000Z' },
    { name: 'none', createdAt: null },
  ];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`SET TIME ZONE 'America/New_York'`);
    await db.exec(`CREATE TABLE events (name TEXT, "createdAt" TIMESTAMPTZ)`);
    for (const r of rows)
      await db.query(`INSERT INTO events VALUES ($1, $2)`, [r.name, r.createdAt]);
  });

  afterAll(async () => {
    await db.close();
  });

  const cases: Record<string, Condition> = {
    'zoneless ISO': {
      field: 'createdAt',
      operator: Operator.greaterThan,
      value: '2026-09-01T08:00:00',
      coerceType: 'DateTime',
    },
    'day-only between': {
      field: 'createdAt',
      operator: Operator.between,
      value: ['2026-09-01', '2026-09-02'],
      coerceType: 'DateTime',
    },
    'epoch ms in a list': {
      field: 'createdAt',
      operator: Operator.in,
      value: [Date.parse('2026-09-01T10:00:00Z')],
      coerceType: 'DateTime',
    },
  };

  for (const [label, rule] of Object.entries(cases)) {
    it(`agrees with check(): ${label}`, async () => {
      const { sql, params } = toSql(rule, opts);
      const viaSql = (
        await db.query<{ name: string }>(
          `SELECT name FROM events AS "t0" WHERE ${sql} ORDER BY name`,
          params,
        )
      ).rows.map((r) => r.name);
      const inMemory = rows
        .filter((r) => check(rule, r) === true)
        .map((r) => r.name)
        .sort();
      expect(viaSql).toEqual(inMemory);
    });
  }
});
