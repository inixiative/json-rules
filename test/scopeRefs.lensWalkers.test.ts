import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '../src/fieldMap/types';
import { coerceRule } from '../src/lens/coerceRule';
import { createLens } from '../src/lens/createLens';
import { describeRule } from '../src/lens/describeRule';
import { describeRuleSources } from '../src/lens/describeRuleSources';
import { narrowRule } from '../src/lens/narrowRule';
import type { LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    Org: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        limit: { kind: 'scalar', type: 'Int' },
        orders: { kind: 'object', type: 'Order', isList: true },
      },
    },
    Order: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        maxQty: { kind: 'scalar', type: 'Int' },
        status: { kind: 'scalar', type: 'String' },
        customer: { kind: 'object', type: 'Customer' },
        lineItems: { kind: 'object', type: 'LineItem', isList: true },
      },
    },
    Customer: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tenantId: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
      },
    },
    LineItem: {
      fields: {
        sku: { kind: 'scalar', type: 'String' },
        qty: { kind: 'scalar', type: 'Int' },
      },
    },
  },
};

const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Org' });
// The relations the gating walkers may cross.
const declared: LensNarrowing = {
  parent: lens,
  root: { relations: { orders: { relations: { lineItems: {}, customer: {} } } } },
};

const atLineItems = (leaf: Condition): Condition => ({
  field: 'orders',
  arrayOperator: ArrayOperator.any,
  condition: { field: 'lineItems', arrayOperator: ArrayOperator.any, condition: leaf },
});

const wOrder: Condition = { field: 'status', operator: Operator.equals, value: 'active' };
const wCustomer: Condition = { field: 'tenantId', operator: Operator.equals, value: 't1' };

describe('narrowRule — narrowing follows a prefixed field to its scope', () => {
  test('a $$$. array rule gets the ancestor relation clamp injected', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: { prisma: { models: { Order: { where: wOrder } } } },
    };
    const idExists: Condition = { field: 'id', operator: Operator.exists };
    const rule = atLineItems({
      field: '$$$.orders',
      arrayOperator: ArrayOperator.any,
      condition: idExists,
    });
    expect(narrowRule(rule, narrowing)).toEqual({
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: {
        all: [
          wOrder,
          {
            field: 'lineItems',
            arrayOperator: ArrayOperator.any,
            condition: {
              field: '$$$.orders',
              arrayOperator: ArrayOperator.any,
              condition: { all: [wOrder, idExists] },
            },
          },
        ],
      },
    });
  });

  test('a to-one hop under a $$. field re-roots the clamp under the same prefix', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: { prisma: { models: { Customer: { where: wCustomer } } } },
    };
    const leaf: Condition = { field: '$$.customer.tier', operator: Operator.equals, value: 'gold' };
    expect(narrowRule(atLineItems(leaf), narrowing)).toEqual({
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'lineItems',
        arrayOperator: ArrayOperator.any,
        condition: {
          all: [{ field: '$$.customer.tenantId', operator: Operator.equals, value: 't1' }, leaf],
        },
      },
    });
  });

  test('an out-of-bounds field fails closed', () => {
    const rule: Condition = { field: '$$.orders', arrayOperator: ArrayOperator.notEmpty };
    expect(() => narrowRule(rule, lens)).toThrow(/depth 2.*only 1/);
  });

  test('a relation clamp authored with a scope ref cannot be re-rooted', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        prisma: {
          models: {
            Customer: { where: { field: '$.tenantId', operator: Operator.equals, value: 't1' } },
          },
        },
      },
    };
    const rule: Condition = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'customer.tier', operator: Operator.equals, value: 'gold' },
    };
    expect(() => narrowRule(rule, narrowing)).toThrow(/re-root/);
  });
});

describe('describeRule — scope refs', () => {
  test('a prefixed field and path describe cleanly and are check-only', () => {
    const result = describeRule(
      atLineItems({ field: '$$.maxQty', operator: Operator.lessThan, path: '$$$.limit' }),
      declared,
    );
    expect(result.errors).toEqual([]);
    expect(result.supportedTargets).toEqual(['check']);
  });

  test('a $. path to a column of the same model and type keeps every rail', () => {
    const result = describeRule(
      { field: 'limit', operator: Operator.greaterThan, path: '$.limit' },
      declared,
    );
    expect([...result.supportedTargets].sort()).toEqual(['check', 'toPrisma', 'toSql']);
  });

  test('an out-of-bounds ref is a violation', () => {
    const result = describeRule(
      atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$$$.limit' }),
      declared,
    );
    expect(result.errors.map((e) => [e.path, e.code])).toEqual([
      ['$$$$.limit', 'scope_out_of_bounds'],
    ]);
  });
});

describe('coerceRule — scope refs', () => {
  test('a prefixed field is stamped from the ancestor model', () => {
    const rule = atLineItems({ field: '$$.maxQty', operator: Operator.equals, value: '5' });
    const stamped = coerceRule(rule, declared) as {
      condition: { condition: { coerceType?: string } };
    };
    expect(stamped.condition.condition.coerceType).toBe('Int');
  });

  test('an out-of-bounds field is left unstamped', () => {
    const rule: Condition = { field: '$$.limit', operator: Operator.equals, value: '5' };
    expect(coerceRule(rule, declared)).toEqual(rule);
  });
});

describe('describeRuleSources — scope refs', () => {
  const narrowing: LensNarrowing = {
    parent: lens,
    root: { relations: { orders: { sources: { maxQty: true }, relations: { lineItems: {} } } } },
  };

  test('a $$. field records its values at the ancestor source', () => {
    const rule = atLineItems({ field: '$$.maxQty', operator: Operator.in, value: [1, 2] });
    expect(describeRuleSources(rule, narrowing)).toEqual([
      {
        path: 'Org.orders',
        mapName: 'prisma',
        model: 'Order',
        field: 'maxQty',
        values: [1, 2],
        dynamic: false,
      },
    ]);
  });

  test('an out-of-bounds field records nothing', () => {
    const rule: Condition = { field: '$$.maxQty', operator: Operator.in, value: [1] };
    expect(describeRuleSources(rule, narrowing)).toEqual([]);
  });
});
