import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { ArrayOperator, DateOperator, Operator } from '../src/operator';
import type { Condition } from '../src/types';

const data = {
  orgLimit: 10,
  deadline: '2026-03-01',
  orders: [
    {
      id: 'o1',
      maxQty: 5,
      shipBy: '2026-02-10',
      window: ['2026-02-01', '2026-02-28'],
      lineItems: [
        { sku: 'a', qty: 3, shippedAt: '2026-02-05', discounts: [{ pct: 4 }] },
        { sku: 'b', qty: 5, shippedAt: '2026-02-09', discounts: [{ pct: 9 }] },
      ],
    },
    {
      id: 'o2',
      maxQty: 2,
      shipBy: '2026-02-20',
      window: ['2026-02-01', '2026-02-28'],
      lineItems: [{ sku: 'c', qty: 3, shippedAt: '2026-02-25', discounts: [{ pct: 12 }] }],
    },
  ],
};

const eachOrder = (condition: Condition, arrayOperator: ArrayOperator = ArrayOperator.all) => ({
  field: 'orders',
  arrayOperator,
  condition,
});

const eachLineItem = (condition: Condition, arrayOperator: ArrayOperator = ArrayOperator.all) => ({
  field: 'lineItems',
  arrayOperator,
  condition,
});

describe('scope refs — $$. reaches the enclosing element', () => {
  test('two-deep: $.qty against $$.maxQty resolves line item vs its order', () => {
    const rule = eachOrder(
      eachLineItem({ field: 'qty', operator: Operator.lessThanEquals, path: '$$.maxQty' }),
    );
    // o1: 3<=5, 5<=5 ✓ ; o2: 3<=2 ✗ → all fails, any passes
    expect(typeof check(rule, data)).toBe('string');
    expect(check(eachOrder(rule.condition, ArrayOperator.any), data)).toBe(true);
  });

  test('three-deep: $$$$. reaches the root row from inside discounts', () => {
    const rule = eachOrder(
      eachLineItem({
        field: 'discounts',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'pct', operator: Operator.lessThan, path: '$$$$.orgLimit' },
      }),
    );
    // pct 4, 9 < 10 ✓ ; pct 12 < 10 ✗
    expect(typeof check(rule, data)).toBe('string');
    expect(check(eachOrder(rule.condition, ArrayOperator.any), data)).toBe(true);
  });

  test('three-deep: $$. from discounts is the line item, not the order', () => {
    const rule = eachOrder(
      eachLineItem({
        field: 'discounts',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'pct', operator: Operator.greaterThan, path: '$$.qty' },
      }),
      ArrayOperator.any,
    );
    // o1: 4>3 ✓, 9>5 ✓ → o1 passes → any true
    expect(check(rule, data)).toBe(true);
  });

  test('logical nesting inside the inner array does not consume a level', () => {
    const rule = eachOrder(
      eachLineItem({
        all: [
          {
            any: [
              { field: 'sku', operator: Operator.equals, value: 'never' },
              {
                if: { field: 'qty', operator: Operator.exists },
                then: { field: 'qty', operator: Operator.lessThanEquals, path: '$$.maxQty' },
              },
            ],
          },
        ],
      }),
      ArrayOperator.any,
    );
    expect(check(rule, data)).toBe(true);
    expect(typeof check(eachOrder(rule.condition), data)).toBe('string');
  });

  test('window filter sees the same scope stack as condition', () => {
    const rule = eachOrder({
      field: 'lineItems',
      arrayOperator: ArrayOperator.exactly,
      count: 2,
      filter: { field: 'qty', operator: Operator.lessThanEquals, path: '$$.maxQty' },
      condition: { field: 'sku', operator: Operator.exists },
    });
    // o1 keeps both line items (3,5 <= 5) → exactly 2 ✓ ; o2 keeps none → ✗
    expect(check(eachOrder(rule.condition, ArrayOperator.any), data)).toBe(true);
    expect(typeof check(rule, data)).toBe('string');
  });

  test('aggregate right-hand path resolves $$. from inside an array operator', () => {
    const rule = eachOrder({
      field: 'lineItems',
      aggregate: { mode: 'sum' as const, field: 'qty' },
      operator: Operator.lessThanEquals,
      path: '$$.orgLimit',
    });
    // o1 sum 8 <= 10 ✓ ; o2 sum 3 <= 10 ✓
    expect(check(rule, data)).toBe(true);
  });

  test('date rail: one-date path with $$. compares against the enclosing order', () => {
    const rule = eachOrder(
      eachLineItem({ field: 'shippedAt', dateOperator: DateOperator.before, path: '$$.shipBy' }),
    );
    // o1: 02-05, 02-09 before 02-10 ✓ ; o2: 02-25 before 02-20 ✗
    expect(typeof check(rule, data)).toBe('string');
    expect(check(eachOrder(rule.condition, ArrayOperator.any), data)).toBe(true);
  });

  test('date rail: between path with $$. reads the two-date array off the order', () => {
    const rule = eachOrder(
      eachLineItem({ field: 'shippedAt', dateOperator: DateOperator.between, path: '$$.window' }),
    );
    expect(check(rule, data)).toBe(true);
  });

  test('bare path reads external context; $$. at depth one reads the root row', () => {
    const row = { limit: 1, orders: [{ total: 50 }] };
    const context = { limit: 100 };
    const viaContext = eachOrder({ field: 'total', operator: Operator.greaterThan, path: 'limit' });
    const viaRoot = eachOrder({ field: 'total', operator: Operator.greaterThan, path: '$$.limit' });
    expect(typeof check(viaContext, row, { context })).toBe('string');
    expect(check(viaRoot, row, { context })).toBe(true);
  });

  test('top level: $.a against $.b is a same-row comparison', () => {
    const rule = { field: '$.a', operator: Operator.lessThan, path: '$.b' };
    expect(check(rule, { a: 1, b: 2 })).toBe(true);
    expect(typeof check(rule, { a: 2, b: 1 })).toBe('string');
  });
});

describe('scope refs — prefixed field', () => {
  test('$$.field against $$$.path compares order to root from the line-item level', () => {
    const rule = eachOrder(
      eachLineItem({ field: '$$.maxQty', operator: Operator.lessThan, path: '$$$.orgLimit' }),
    );
    expect(check(rule, data)).toBe(true);
    const reversed = eachOrder(
      eachLineItem({ field: '$$.maxQty', operator: Operator.greaterThan, path: '$$$.orgLimit' }),
    );
    expect(typeof check(reversed, data)).toBe('string');
  });

  test('$.field against $$.path resolve independently', () => {
    const rule = eachOrder(
      eachLineItem({ field: '$.qty', operator: Operator.lessThanEquals, path: '$$.maxQty' }),
      ArrayOperator.any,
    );
    expect(check(rule, data)).toBe(true);
  });

  test('prefixed field with a literal value', () => {
    const rule = eachOrder(
      eachLineItem({ field: '$$.id', operator: Operator.equals, value: 'o1' }),
      ArrayOperator.any,
    );
    expect(check(rule, data)).toBe(true);
    expect(
      check(
        eachOrder(
          eachLineItem({ field: '$$.id', operator: Operator.equals, value: 'o9' }),
          ArrayOperator.any,
        ),
        data,
      ),
    ).not.toBe(true);
  });

  test('prefixed field with a bind', () => {
    const rule = eachOrder(
      eachLineItem({ field: '$$.id', operator: Operator.equals, bind: 'orderId' }),
      ArrayOperator.any,
    );
    expect(check(rule, data, { bindings: { orderId: 'o2' } })).toBe(true);
    expect(check(rule, data, { bindings: { orderId: 'o9' } })).not.toBe(true);
  });

  test('prefixed field on an array rule iterates the ancestor collection', () => {
    const rule = eachOrder(
      eachLineItem({
        field: '$$$.orders',
        arrayOperator: ArrayOperator.exactly,
        count: 2,
        condition: { field: 'id', operator: Operator.exists },
      }),
    );
    expect(check(rule, data)).toBe(true);
  });

  test('failed comparison names the prefixed field as written', () => {
    const rule = { field: '$.orgLimit', operator: Operator.greaterThan, value: 100 };
    expect(check(rule, data)).toContain('$.orgLimit must be greater than');
  });
});

describe('scope refs — out of bounds and missing', () => {
  test('$$. path at the top level throws naming the depth', () => {
    const rule = { field: 'orgLimit', operator: Operator.equals, path: '$$.orgLimit' };
    expect(() => check(rule, data)).toThrow(/'\$\$\.orgLimit'.*depth 2.*only 1/);
  });

  test('$$$. path one level deep throws', () => {
    const rule = eachOrder({ field: 'maxQty', operator: Operator.equals, path: '$$$.orgLimit' });
    expect(() => check(rule, data)).toThrow(/depth 3.*only 2/);
  });

  test('$$. field at the top level throws even when path is valid', () => {
    const rule = { field: '$$.orgLimit', operator: Operator.equals, path: 'orgLimit' };
    expect(() => check(rule, data)).toThrow(/'\$\$\.orgLimit'.*depth 2.*only 1/);
  });

  test('$$$. field one level deep throws', () => {
    const rule = eachOrder({ field: '$$$.orgLimit', operator: Operator.equals, value: 10 });
    expect(() => check(rule, data)).toThrow(/depth 3.*only 2/);
  });

  test('out-of-bounds field on an array rule throws', () => {
    const rule = { field: '$$.orders', arrayOperator: ArrayOperator.notEmpty };
    expect(() => check(rule, data)).toThrow(/depth 2.*only 1/);
  });

  test('a missing suffix on a reachable ancestor fails the comparison, not the evaluation', () => {
    const rule = eachOrder(
      eachLineItem({ field: 'qty', operator: Operator.equals, path: '$$.notThere' }),
    );
    expect(typeof check(rule, data)).toBe('string');
  });
});
