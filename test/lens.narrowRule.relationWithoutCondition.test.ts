import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import type { FieldMap } from '../src/fieldMap/types';
import { narrowRule } from '../src/lens/narrowRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { Condition } from '../src/types';

// A relation node with no `condition` — emptiness, an aggregate — still crosses its
// relation. Its clamps scope the rows it reads (via `filter`), and the relations its own
// `filter` reaches keep their clamps. Before, both were skipped.

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

describe('narrowRule — a relation node without a condition', () => {
  test('emptiness reads only the rows its clamp allows', () => {
    const rule = { field: 'orders', arrayOperator: ArrayOperator.notEmpty } as Condition;
    const composed = narrowRule(rule, ordersScoped) as { filter?: Condition };
    expect(composed.filter).toEqual(live);
    const allDeleted = { id: 'c1', orders: [{ total: 9, deletedAt: '2026-01-01' }] };
    expect(check(rule, allDeleted)).toBe(true);
    expect(check(narrowRule(rule, ordersScoped), allDeleted)).not.toBe(true);
  });

  test('an aggregate sums only the rows its clamp allows', () => {
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum', field: 'total' },
      operator: Operator.greaterThan,
      value: 10,
    } as Condition;
    expect(check(rule, data)).toBe(true);
    expect(check(narrowRule(rule, ordersScoped), data)).not.toBe(true);
  });

  test('clamps on relations the filter reaches are injected', () => {
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
    const composed = narrowRule(rule, customerScoped);
    const orders = (...customers: (string | null)[]) => ({
      id: 'c2',
      orders: customers.map((id) => ({ customer: id === null ? null : { id } })),
    });
    // A hidden customer fails the filter; a visible one and a missing one pass it.
    expect(check(composed, orders('c3'))).not.toBe(true);
    expect(check(composed, orders('c2'))).toBe(true);
    expect(check(composed, orders(null))).toBe(true);
  });
});
