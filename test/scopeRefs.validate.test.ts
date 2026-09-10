import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator, validateRule } from '../index';

const codes = (rule: unknown, target?: 'check' | 'toSql' | 'toPrisma') =>
  validateRule(rule, target ? { target } : {}).errors.map((e) => `${e.code}@${e.path}`);

const inOrders = (condition: unknown) => ({
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition,
});

const inLineItems = (condition: unknown) => ({
  field: 'lineItems',
  arrayOperator: ArrayOperator.any,
  condition,
});

describe('validateRule — scope refs in bounds', () => {
  test('$$. two deep and $$$$. three deep pass', () => {
    const rule = inOrders(
      inLineItems({
        all: [
          { field: 'qty', operator: Operator.lessThanEquals, path: '$$.maxQty' },
          {
            field: 'discounts',
            arrayOperator: ArrayOperator.all,
            condition: { field: 'pct', operator: Operator.lessThan, path: '$$$$.orgLimit' },
          },
        ],
      }),
    );
    expect(validateRule(rule)).toEqual({ ok: true, errors: [] });
  });

  test('prefixed field and prefixed path together pass at a valid depth', () => {
    const rule = inOrders(
      inLineItems({ field: '$$.maxQty', operator: Operator.lessThan, path: '$$$.orgLimit' }),
    );
    expect(validateRule(rule)).toEqual({ ok: true, errors: [] });
  });

  test('window filter is one level deeper than the array rule', () => {
    const rule = inOrders({
      field: 'lineItems',
      arrayOperator: ArrayOperator.exactly,
      count: 1,
      filter: { field: 'qty', operator: Operator.lessThanEquals, path: '$$.maxQty' },
      condition: { field: 'sku', operator: Operator.exists },
    });
    expect(validateRule(rule)).toEqual({ ok: true, errors: [] });
  });

  test('aggregate condition and filter are one level deeper; its own path is not', () => {
    const rule = inOrders({
      field: 'lineItems',
      aggregate: { mode: 'sum', field: 'qty' },
      filter: { field: 'qty', operator: Operator.greaterThan, path: '$$.floor' },
      condition: { field: 'sku', operator: Operator.notEquals, path: '$$.excludedSku' },
      operator: Operator.lessThanEquals,
      path: '$$.orgLimit',
    });
    expect(validateRule(rule)).toEqual({ ok: true, errors: [] });
  });

  test('$. at the top level is a same-row ref and passes for check', () => {
    const rule = { field: '$.a', operator: Operator.lessThan, path: '$.b' };
    expect(validateRule(rule)).toEqual({ ok: true, errors: [] });
  });
});

describe('validateRule — scope refs out of bounds', () => {
  test('$$. path at the top level', () => {
    const rule = { field: 'a', operator: Operator.equals, path: '$$.a' };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.path']);
    expect(validateRule(rule).errors[0]?.message).toMatch(/'\$\$\.a'.*depth 2.*only 1/);
  });

  test('$$. field at the top level, path valid', () => {
    const rule = { field: '$$.a', operator: Operator.equals, path: 'a' };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.field']);
  });

  test('both field and path out of bounds report separately', () => {
    const rule = { field: '$$.a', operator: Operator.equals, path: '$$$.b' };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.field', 'scope_out_of_bounds@$.path']);
  });

  test('$$$. path one level deep points at the leaf', () => {
    const rule = inOrders({ field: 'maxQty', operator: Operator.equals, path: '$$$.orgLimit' });
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.condition.path']);
  });

  test('logical combinators do not add depth', () => {
    const rule = { all: [{ any: [{ field: 'a', operator: Operator.equals, path: '$$.b' }] }] };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.all[0].any[0].path']);
  });

  test('array rule field out of bounds', () => {
    const rule = { field: '$$.orders', arrayOperator: ArrayOperator.notEmpty };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.field']);
  });

  test('aggregate rule field and path out of bounds', () => {
    const rule = {
      field: '$$.orders',
      aggregate: { mode: 'sum', field: 'total' },
      operator: Operator.greaterThan,
      path: '$$.cap',
    };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.field', 'scope_out_of_bounds@$.path']);
  });

  test('date rule field and path out of bounds', () => {
    const rule = { field: '$$.shippedAt', dateOperator: DateOperator.before, path: '$$.shipBy' };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.field', 'scope_out_of_bounds@$.path']);
  });

  test('window filter that reaches past the array root', () => {
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.exactly,
      count: 1,
      filter: { field: 'total', operator: Operator.greaterThan, path: '$$$.cap' },
      condition: { field: 'id', operator: Operator.exists },
    };
    expect(codes(rule)).toEqual(['scope_out_of_bounds@$.filter.path']);
  });
});

describe('validateRule — scope refs per compile target', () => {
  test('toPrisma rejects any prefixed path, including $$.', () => {
    const rule = inOrders({ field: 'total', operator: Operator.lessThan, path: '$$.cap' });
    expect(codes(rule, 'toPrisma')).toEqual(['unsupported_prisma_path@$.condition.path']);
  });

  test('toPrisma rejects a prefixed field', () => {
    const rule = inOrders({ field: '$$.cap', operator: Operator.greaterThan, value: 1 });
    expect(codes(rule, 'toPrisma')).toEqual(['unsupported_prisma_field@$.condition.field']);
  });

  test('toSql keeps $. path as column-to-column but rejects a prefixed field', () => {
    expect(codes({ field: 'a', operator: Operator.lessThan, path: '$.b' }, 'toSql')).toEqual([]);
    expect(codes({ field: '$.a', operator: Operator.lessThan, value: 1 }, 'toSql')).toEqual([
      'unsupported_sql_field@$.field',
    ]);
  });

  test('toSql rejects a date rule with a prefixed field', () => {
    const rule = { field: '$.shippedAt', dateOperator: DateOperator.before, value: '2026-01-01' };
    expect(codes(rule, 'toSql')).toEqual(['unsupported_sql_field@$.field']);
  });
});
