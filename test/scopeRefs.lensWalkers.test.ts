import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import { createLens } from '../src/lens/createLens';
import { describeRule } from '../src/lens/describeRule';
import { ruleSourceValues } from '../src/lens/ruleSourceValues';
import { stampCoercions } from '../src/lens/stampCoercions';
import type { LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
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

const atLineItems = (leaf: Condition): Condition => ({
  field: 'orders',
  arrayOperator: ArrayOperator.any,
  condition: { field: 'lineItems', arrayOperator: ArrayOperator.any, condition: leaf },
});

const wOrder: Condition = { field: 'status', operator: Operator.equals, value: 'active' };
const wCustomer: Condition = { field: 'tenantId', operator: Operator.equals, value: 't1' };

describe('applyLens — narrowing follows a prefixed field to its scope', () => {
  test('a $$$. array rule gets the ancestor relation grant injected', () => {
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
    expect(applyLens(rule, narrowing)).toEqual({
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

  test('a to-one hop under a $$. field re-roots the grant under the same prefix', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: { prisma: { models: { Customer: { where: wCustomer } } } },
    };
    const leaf: Condition = { field: '$$.customer.tier', operator: Operator.equals, value: 'gold' };
    expect(applyLens(atLineItems(leaf), narrowing)).toEqual({
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
    expect(() => applyLens(rule, lens)).toThrow(/depth 2.*only 1/);
  });

  test('a relation grant authored with a scope ref cannot be re-rooted', () => {
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
    expect(() => applyLens(rule, narrowing)).toThrow(/re-root/);
  });
});

describe('describeRule — scope refs', () => {
  test('a prefixed field and path describe cleanly and are check-only', () => {
    const result = describeRule(
      atLineItems({ field: '$$.maxQty', operator: Operator.lessThan, path: '$$$.limit' }),
      lens,
    );
    expect(result.violations).toEqual([]);
    expect(result.supportedTargets).toEqual(['check']);
  });

  test('$. path alone keeps toSql and drops toPrisma', () => {
    const result = describeRule(
      { field: 'limit', operator: Operator.greaterThan, path: '$.limit' },
      lens,
    );
    expect(result.supportedTargets).toEqual(['check', 'toSql']);
  });

  test('an out-of-bounds ref is a violation', () => {
    const result = describeRule(
      atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$$$.limit' }),
      lens,
    );
    expect(result.violations).toEqual(['$$$$.limit']);
  });
});

describe('stampCoercions — scope refs', () => {
  test('a prefixed field is stamped from the ancestor model', () => {
    const rule = atLineItems({ field: '$$.maxQty', operator: Operator.equals, value: '5' });
    const stamped = stampCoercions(rule, lens) as {
      condition: { condition: { coerceType?: string } };
    };
    expect(stamped.condition.condition.coerceType).toBe('Int');
  });

  test('an out-of-bounds field is left unstamped', () => {
    const rule: Condition = { field: '$$.limit', operator: Operator.equals, value: '5' };
    expect(stampCoercions(rule, lens)).toEqual(rule);
  });
});

describe('ruleSourceValues — scope refs', () => {
  const narrowing: LensNarrowing = {
    parent: lens,
    root: { relations: { orders: { sources: { maxQty: true } } } },
  };

  test('a $$. field records its values at the ancestor source', () => {
    const rule = atLineItems({ field: '$$.maxQty', operator: Operator.in, value: [1, 2] });
    expect(ruleSourceValues(narrowing, rule)).toEqual([
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
    expect(ruleSourceValues(narrowing, rule)).toEqual([]);
  });
});
