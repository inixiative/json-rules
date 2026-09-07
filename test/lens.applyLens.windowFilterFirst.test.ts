import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';
import type { Condition } from '../src/types';
import { getWhere } from './fixtures/helpers';

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
        status: { kind: 'scalar', type: 'String' },
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
const scope: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
const scoped: LensNarrowing = {
  parent: lens,
  mapDefaults: { prisma: { models: { Order: { where: scope } } } },
};
const paid: Condition = { field: 'status', operator: Operator.equals, value: 'paid' };
const prismaOpts = { map: lens, mapName: 'prisma', model: 'Customer' };

describe('applyLens — a windowed rule takes its grant as the window filter (filter-first)', () => {
  test('windowed any: the grant is the filter, the user condition is untouched', () => {
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'total', dir: 'desc' }],
      take: 1,
      condition: paid,
    } as unknown as Condition;
    const composed = applyLens(rule, scoped) as { filter?: Condition; condition?: Condition };
    expect(composed.filter).toEqual(scope);
    expect(composed.condition).toEqual(paid);
    // A deleted top row must not displace the in-scope top row.
    const data = {
      orders: [
        { total: 999, status: 'unpaid', deletedAt: '2020-01-01' },
        { total: 10, status: 'paid' },
      ],
    };
    expect(check(composed as Condition, data)).toBe(true);
  });

  test('windowed none: a deleted top row cannot mask an in-scope violating row', () => {
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.none,
      orderBy: [{ field: 'total', dir: 'desc' }],
      take: 1,
      condition: { field: 'status', operator: Operator.equals, value: 'refunded' },
    } as unknown as Condition;
    const composed = applyLens(rule, scoped);
    const data = {
      orders: [
        { total: 999, status: 'paid', deletedAt: '2020-01-01' },
        { total: 10, status: 'refunded' }, // the in-scope top row — none() must see it
      ],
    };
    expect(check(composed, data)).not.toBe(true);
  });

  test('windowed aggregate: the window runs over in-scope rows only', () => {
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum', field: 'total' },
      condition: true,
      orderBy: [{ field: 'total', dir: 'desc' }],
      take: 2,
      operator: Operator.greaterThan,
      value: 100,
    } as unknown as Condition;
    const composed = applyLens(rule, scoped) as { filter?: Condition; condition?: Condition };
    expect(composed.filter).toEqual(scope);
    expect(composed.condition).toBe(true);
    const data = { orders: [{ total: 999, deletedAt: '2020-01-01' }, { total: 10 }, { total: 5 }] };
    // in-scope top-2 sum = 15, not > 100 (the deleted 999 must not be in the window)
    expect(check(composed as Condition, data)).not.toBe(true);
  });

  test('windowed rule with a user filter: the grant is AND-ed into the filter', () => {
    const userFilter: Condition = { field: 'total', operator: Operator.greaterThan, value: 0 };
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      filter: userFilter,
      take: 1,
      condition: paid,
    } as unknown as Condition;
    const composed = applyLens(rule, scoped) as { filter?: Condition; condition?: Condition };
    expect(composed.filter).toEqual({ all: [userFilter, scope] });
    expect(composed.condition).toEqual(paid);
  });

  test('relations inside the user filter retain their own scope before selection', () => {
    const customerScoped: LensNarrowing = {
      parent: scoped,
      mapDefaults: {
        prisma: {
          models: {
            Customer: {
              where: {
                field: 'id',
                operator: Operator.equals,
                value: 'c1',
              },
            },
          },
        },
      },
    };
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      filter: { field: 'customer.id', operator: Operator.notEquals, value: 'none' },
      orderBy: [{ field: 'total', dir: 'desc' }],
      take: 1,
      condition: paid,
    } as Condition;
    expect(
      check(applyLens(rule, customerScoped), {
        id: 'c1',
        orders: [
          { total: 100, status: 'unpaid', customer: { id: 'c2' } },
          { total: 10, status: 'paid', customer: { id: 'c1' } },
        ],
      }),
    ).toBe(true);
  });

  test('compilers reject the scoped window when they cannot preserve its filter', () => {
    const composed = applyLens(
      {
        field: 'orders',
        arrayOperator: ArrayOperator.any,
        orderBy: [{ field: 'total', dir: 'desc' }],
        take: 1,
        condition: paid,
      } as Condition,
      scoped,
    );
    expect(() => toPrisma(composed, prismaOpts)).toThrow(/Windowing/);
    expect(() => toSql(composed, { map, model: 'Customer' })).toThrow(/Windowing/);
  });

  test('an empty orderBy is not a window: AND injection is kept and still compiles', () => {
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      orderBy: [],
      condition: paid,
    } as unknown as Condition;
    const composed = applyLens(rule, scoped) as { filter?: Condition; condition: Condition };
    expect(composed.filter).toBeUndefined();
    expect(composed.condition).toEqual({ all: [scope, paid] });
    expect(() => toPrisma(composed as Condition, prismaOpts)).not.toThrow();
  });

  test('un-windowed any retains its scoped Prisma query', () => {
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: paid,
    } as Condition;
    const composed = applyLens(rule, scoped) as { filter?: Condition; condition: Condition };
    expect(composed.filter).toBeUndefined();
    expect(composed.condition).toEqual({ all: [scope, paid] });
    expect(getWhere(toPrisma(composed as Condition, prismaOpts))).toEqual({
      orders: { some: { AND: [{ deletedAt: { equals: null } }, { status: { equals: 'paid' } }] } },
    });
  });
});
