import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// A relation node with no `condition` — emptiness, an aggregate — still crosses its
// relation. Its grants scope the rows it reads (via `filter`), and the relations its own
// `filter` reaches keep their grants. Before, both were skipped.

const map: FieldMap = {
  models: {
    Customer: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        orders: { kind: 'object', type: 'Order', isList: true },
      },
    },
    Order: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        customerId: { kind: 'scalar', type: 'String' },
        total: { kind: 'scalar', type: 'Int' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        customer: {
          kind: 'object',
          type: 'Customer',
          fromFields: ['customerId'],
          toFields: ['id'],
        },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'Customer' };
const live: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
const ordersScoped: LensNarrowing = {
  parent: lens,
  mapDefaults: { prisma: { models: { Order: { where: live } } } },
};

const data = {
  id: 'c1',
  orders: [
    { total: 5, deletedAt: null, customer: { id: 'c1' } },
    { total: 9, deletedAt: '2026-01-01', customer: { id: 'c1' } },
    { total: 7, deletedAt: '2026-01-01', customer: { id: 'c1' } },
  ],
};

describe('applyLens — a relation node without a condition', () => {
  test('emptiness reads only the rows its grant allows', () => {
    const rule = { field: 'orders', arrayOperator: ArrayOperator.notEmpty } as Condition;
    const composed = applyLens(rule, ordersScoped) as { filter?: Condition };
    expect(composed.filter).toEqual(live);
    const allDeleted = { id: 'c1', orders: [{ total: 9, deletedAt: '2026-01-01' }] };
    expect(check(rule, allDeleted)).toBe(true);
    expect(check(applyLens(rule, ordersScoped), allDeleted)).not.toBe(true);
  });

  test('an aggregate sums only the rows its grant allows', () => {
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum', field: 'total' },
      operator: Operator.greaterThan,
      value: 10,
    } as Condition;
    expect(check(rule, data)).toBe(true);
    expect(check(applyLens(rule, ordersScoped), data)).not.toBe(true);
  });

  test('grants on relations the filter reaches are injected', () => {
    const customerScoped: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        prisma: {
          models: { Customer: { where: { field: 'id', operator: Operator.equals, value: 'c2' } } },
        },
      },
    };
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.notEmpty,
      filter: { field: 'customer.id', operator: Operator.notEquals, value: 'none' },
    } as Condition;
    const composed = applyLens(rule, customerScoped) as { all: Condition[] };
    const scopedRule = composed.all.at(-1) as { filter: Condition };
    expect(scopedRule.filter).toEqual({
      all: [
        { field: 'customer.id', operator: Operator.equals, value: 'c2' },
        { field: 'customer.id', operator: Operator.notEquals, value: 'none' },
      ],
    });
  });
});
