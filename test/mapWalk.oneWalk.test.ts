import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap } from '../index';
import { toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// One map walk serves every leaf on both compilers: relation hops join (toSql) or nest
// (toPrisma), a Json column's tail is a JSON path, and a path past any other column is an error.

const map: FieldMap = {
  models: {
    Order: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        customerId: { kind: 'scalar', type: 'String' },
        note: { kind: 'scalar', type: 'String' },
        customer: {
          kind: 'object',
          type: 'Customer',
          fromFields: ['customerId'],
          toFields: ['id'],
        },
      },
    },
    Customer: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tags: { kind: 'scalar', type: 'String', isList: true },
        meta: { kind: 'scalar', type: 'Json' },
      },
    },
  },
} as never;
const opts = { map, model: 'Order' };
const rule = (r: object): Condition => r as never;

describe('toSql array and aggregate rules walk their field', () => {
  test('a native array through a relation joins', () => {
    const { sql, joins } = toSql(rule({ field: 'customer.tags', arrayOperator: 'notEmpty' }), opts);
    expect(joins).toEqual(['LEFT JOIN "Customer" AS "t1" ON "t1"."id" = "t0"."customerId"']);
    expect(sql).toBe('cardinality("t1"."tags") > 0');
  });

  test('a JSON array through a relation reads as JSONB', () => {
    const { sql } = toSql(rule({ field: 'customer.meta.scores', arrayOperator: 'empty' }), opts);
    expect(sql).toBe(
      `("t1"."meta"->'scores' IS NULL OR "t1"."meta"->'scores' IN ('null'::jsonb, '[]'::jsonb))`,
    );
  });

  test('an aggregate through a relation joins', () => {
    const { sql } = toSql(
      rule({
        field: 'customer.meta.scores',
        aggregate: { mode: 'sum' },
        operator: 'greaterThan',
        value: 3,
      }),
      opts,
    );
    expect(sql).toContain(
      `jsonb_array_elements_text((CASE WHEN jsonb_typeof("t1"."meta"->'scores') = 'array' THEN "t1"."meta"->'scores' END))`,
    );
  });
});

describe('a path past a non-Json column is an error on both compilers', () => {
  const past = rule({ field: 'note.x', operator: 'equals', value: 1 });
  test('toSql and toPrisma', () => {
    expect(() => toSql(past, opts)).toThrow("continues past 'note'");
    expect(() => toPrisma(past, opts)).toThrow("continues past 'note'");
  });
});

describe('toPrisma date rules are map-aware', () => {
  test('a date in Json is text, which Prisma compares as text: refused', () => {
    expect(() =>
      toPrisma(
        rule({
          field: 'customer.meta.since',
          dateOperator: 'before',
          value: '2026-01-01T00:00:00Z',
        }),
        opts,
      ),
    ).toThrow('has no Prisma form');
  });
});

describe('a bridged leaf stays over-fetch under negation', () => {
  const bridged = {
    models: {
      Order: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          'crm:Deal': { kind: 'bridge', type: 'crm:Deal' },
        },
      },
    },
  } as never;
  test('a date notBetween through a bridge is {} (Prisma reads NOT: {} as match-all too)', () => {
    const where = getWhere(
      toPrisma(
        rule({
          field: 'crm:Deal.closedAt',
          dateOperator: 'notBetween',
          value: ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
        }),
        { map: bridged, model: 'Order' },
      ),
    );
    expect(where).toEqual({});
  });
});
