import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { createLens } from '../src/lens/createLens';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

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
        meta: { kind: 'scalar', type: 'Json' },
        lineItems: { kind: 'object', type: 'LineItem', isList: true },
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

const atLineItems = (leaf: unknown) => ({
  field: 'orders',
  arrayOperator: ArrayOperator.any,
  condition: {
    field: 'lineItems',
    arrayOperator: ArrayOperator.any,
    condition: leaf,
  },
});

const gate = (rule: unknown) => checkRuleAgainstLens(rule as never, lens);

describe('lens gate — scoped path refs walk from the ancestor visit', () => {
  test('$$. path resolves against the enclosing Order', () => {
    const ok = gate(atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$.maxQty' }));
    expect(ok).toEqual({ ok: true, violations: [] });
    const bad = gate(atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$.maxQty' }));
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('$.maxQty');
  });

  test('$$$. path resolves against the Org root; $$. does not reach it', () => {
    expect(
      gate(atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$$.limit' })).ok,
    ).toBe(true);
    const bad = gate(atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$.limit' }));
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('$$.limit');
  });

  test('bare path still resolves at the lens root regardless of depth', () => {
    expect(gate(atLineItems({ field: 'qty', operator: Operator.lessThan, path: 'limit' })).ok).toBe(
      true,
    );
    expect(
      gate(atLineItems({ field: 'qty', operator: Operator.lessThan, path: 'maxQty' })).ok,
    ).toBe(false);
  });

  test('$$. path outside the narrowed lens is a violation', () => {
    const narrowed = createLens({
      maps: { prisma: map },
      mapName: 'prisma',
      model: 'Org',
      narrowing: { Order: { fields: ['id', 'lineItems'] } },
    } as never);
    const result = checkRuleAgainstLens(
      atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$.maxQty' }) as never,
      narrowed,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.path).toBe('$$.maxQty');
  });
});

describe('lens gate — scoped field refs', () => {
  test('$$.field names a column on the enclosing Order', () => {
    expect(
      gate(atLineItems({ field: '$$.maxQty', operator: Operator.greaterThan, value: 1 })).ok,
    ).toBe(true);
    const bad = gate(atLineItems({ field: '$$.sku', operator: Operator.exists }));
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('$$.sku');
  });

  test('$$.field against $$$.path gates each side at its own scope', () => {
    expect(
      gate(atLineItems({ field: '$$.maxQty', operator: Operator.lessThan, path: '$$$.limit' })).ok,
    ).toBe(true);
    const bad = gate(
      atLineItems({ field: '$$.maxQty', operator: Operator.lessThan, path: '$$$.maxQty' }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => v.path)).toEqual(['$$$.maxQty']);
  });

  test('prefixed field on an array rule descends into the ancestor collection', () => {
    const ok = gate(
      atLineItems({
        field: '$$$.orders',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'id', operator: Operator.exists },
      }),
    );
    expect(ok.ok).toBe(true);
    const bad = gate(
      atLineItems({
        field: '$$$.orders',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'sku', operator: Operator.exists },
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('sku');
  });
});

describe('lens gate — out of bounds', () => {
  test('path deeper than the nesting is a violation naming the depth', () => {
    const bad = gate(
      atLineItems({ field: 'qty', operator: Operator.lessThan, path: '$$$$.limit' }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('$$$$.limit');
    expect(bad.violations[0]?.reason).toMatch(/depth 4.*only 3/);
  });

  test('field deeper than the nesting is a violation', () => {
    const bad = gate({ field: '$$.limit', operator: Operator.greaterThan, value: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('$$.limit');
    expect(bad.violations[0]?.reason).toMatch(/depth 2.*only 1/);
  });

  test('field and path both out of bounds report separately', () => {
    const bad = gate({ field: '$$.limit', operator: Operator.lessThan, path: '$$$.limit' });
    expect(bad.violations.map((v) => v.path)).toEqual(['$$.limit', '$$$.limit']);
  });
});

describe('lens gate — open Json scopes', () => {
  const inMeta = (leaf: unknown) => ({
    field: 'orders',
    arrayOperator: ArrayOperator.any,
    condition: { field: 'meta', arrayOperator: ArrayOperator.any, condition: leaf },
  });

  test('$. inside a Json element is open and not gated', () => {
    expect(
      gate(inMeta({ field: 'anything', operator: Operator.equals, path: '$.whatever' })).ok,
    ).toBe(true);
  });

  test('$$. from inside a Json element points back at the declared Order and is gated', () => {
    expect(
      gate(inMeta({ field: 'anything', operator: Operator.equals, path: '$$.maxQty' })).ok,
    ).toBe(true);
    const bad = gate(inMeta({ field: 'anything', operator: Operator.equals, path: '$$.nope' }));
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.path).toBe('$$.nope');
  });

  test('$$.field from inside a Json element is gated at the Order', () => {
    expect(gate(inMeta({ field: '$$.maxQty', operator: Operator.greaterThan, value: 1 })).ok).toBe(
      true,
    );
    expect(gate(inMeta({ field: '$$.nope', operator: Operator.exists })).ok).toBe(false);
  });
});
