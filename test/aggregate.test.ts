import { describe, expect, it } from 'bun:test';
import type { GroupByStep } from '../index';
import {
  ArrayOperator,
  check,
  DateOperator,
  Operator,
  toPrisma,
  toSql,
  validateRule,
} from '../index';
import { getWhere } from './fixtures/helpers';
import { orderMap } from './fixtures/orderMap';

// ─── check() ──────────────────────────────────────────────────────────────────

describe('check() aggregate rules', () => {
  describe('primitive array', () => {
    it('sum > value passes', () => {
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'sum' },
            operator: Operator.greaterThan,
            value: 200,
          },
          { scores: [80, 90, 70] },
        ),
      ).toBe(true);
    });

    it('sum > value fails', () => {
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'sum' },
            operator: Operator.greaterThan,
            value: 300,
          },
          { scores: [80, 90, 70] },
        ),
      ).toBe('scores sum must be greater than 300');
    });

    it('avg >= value passes', () => {
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'avg' },
            operator: Operator.greaterThanEquals,
            value: 80,
          },
          { scores: [80, 90, 70] },
        ),
      ).toBe(true);
    });

    it('avg >= value fails', () => {
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'avg' },
            operator: Operator.greaterThanEquals,
            value: 90,
          },
          { scores: [80, 90, 70] },
        ),
      ).not.toBe(true);
    });

    it('sum([]) = 0', () => {
      expect(
        check(
          { field: 'scores', aggregate: { mode: 'sum' }, operator: Operator.equals, value: 0 },
          { scores: [] },
        ),
      ).toBe(true);
    });

    it('avg([]) fails comparison', () => {
      expect(
        check(
          { field: 'scores', aggregate: { mode: 'avg' }, operator: Operator.greaterThan, value: 0 },
          { scores: [] },
        ),
      ).not.toBe(true);
    });

    it('between passes', () => {
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'sum' },
            operator: Operator.between,
            value: [200, 300],
          },
          { scores: [80, 90, 70] },
        ),
      ).toBe(true);
    });

    it('notBetween passes', () => {
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'sum' },
            operator: Operator.notBetween,
            value: [0, 100],
          },
          { scores: [80, 90, 70] },
        ),
      ).toBe(true);
    });

    it('path RHS resolves from context', () => {
      const data = { scores: [80, 90, 70], minRequired: 200 };
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'sum' },
            operator: Operator.greaterThan,
            path: 'minRequired',
          },
          data,
        ),
      ).toBe(true);
    });

    it('$.path RHS resolves from current data', () => {
      const data = { scores: [80, 90, 70], threshold: 200 };
      expect(
        check(
          {
            field: 'scores',
            aggregate: { mode: 'sum' },
            operator: Operator.greaterThan,
            path: '$.threshold',
          },
          data,
        ),
      ).toBe(true);
    });
  });

  describe('object array', () => {
    const data = {
      orders: [{ total: 100 }, { total: 200 }, { total: 150 }],
    };

    it('sum of item field passes', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            operator: Operator.equals,
            value: 450,
          },
          data,
        ),
      ).toBe(true);
    });

    it('avg of item field passes', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'avg', field: 'total' },
            operator: Operator.equals,
            value: 150,
          },
          data,
        ),
      ).toBe(true);
    });

    it('sum of item field fails with error', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            operator: Operator.greaterThan,
            value: 500,
          },
          data,
        ),
      ).toBe('orders sum must be greater than 500');
    });

    it('custom error message', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            operator: Operator.greaterThan,
            value: 500,
            error: 'order total too low',
          },
          data,
        ),
      ).toBe('order total too low');
    });
  });

  describe('errors', () => {
    it('throws if field is not an array', () => {
      expect(() =>
        check(
          { field: 'score', aggregate: { mode: 'sum' }, operator: Operator.greaterThan, value: 0 },
          { score: 42 },
        ),
      ).toThrow('score must be an array');
    });

    it('throws if primitive element is not a number', () => {
      expect(() =>
        check(
          { field: 'scores', aggregate: { mode: 'sum' }, operator: Operator.greaterThan, value: 0 },
          { scores: [1, 'oops', 3] },
        ),
      ).toThrow('scores[1] must be a finite number');
    });

    it('throws if object element field is not a number', () => {
      expect(() =>
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            operator: Operator.greaterThan,
            value: 0,
          },
          { orders: [{ total: 'bad' }] },
        ),
      ).toThrow('orders[0].total must be a finite number');
    });
  });

  describe('filtered aggregate (condition)', () => {
    const data = {
      orders: [
        { total: 100, status: 'completed', year: 2025 },
        { total: 200, status: 'completed', year: 2026 },
        { total: 150, status: 'pending', year: 2026 },
        { total: 50, status: 'cancelled', year: 2025 },
      ],
    };

    it('sum with condition — only completed orders', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: { field: 'status', operator: Operator.equals, value: 'completed' },
            operator: Operator.equals,
            value: 300,
          },
          data,
        ),
      ).toBe(true);
    });

    it('sum with condition — only 2026 orders', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: { field: 'year', operator: Operator.equals, value: 2026 },
            operator: Operator.equals,
            value: 350,
          },
          data,
        ),
      ).toBe(true);
    });

    it('avg with condition — avg of completed orders', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'avg', field: 'total' },
            condition: { field: 'status', operator: Operator.equals, value: 'completed' },
            operator: Operator.equals,
            value: 150,
          },
          data,
        ),
      ).toBe(true);
    });

    it('sum with compound condition (all)', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: {
              all: [
                { field: 'status', operator: Operator.equals, value: 'completed' },
                { field: 'year', operator: Operator.equals, value: 2026 },
              ],
            },
            operator: Operator.equals,
            value: 200,
          },
          data,
        ),
      ).toBe(true);
    });

    it('condition filters out all elements — sum is 0', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: { field: 'status', operator: Operator.equals, value: 'refunded' },
            operator: Operator.equals,
            value: 0,
          },
          data,
        ),
      ).toBe(true);
    });

    it('condition filters out all elements — avg fails (null)', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'avg', field: 'total' },
            condition: { field: 'status', operator: Operator.equals, value: 'refunded' },
            operator: Operator.greaterThan,
            value: 0,
          },
          data,
        ),
      ).not.toBe(true);
    });

    it('no condition — aggregates all elements (backward compatible)', () => {
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            operator: Operator.equals,
            value: 500,
          },
          data,
        ),
      ).toBe(true);
    });

    it('date condition — sum orders after a date', () => {
      const dateData = {
        orders: [
          { total: 100, createdAt: '2025-06-01' },
          { total: 200, createdAt: '2026-03-15' },
          { total: 150, createdAt: '2026-07-01' },
        ],
      };
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: {
              field: 'createdAt',
              dateOperator: DateOperator.after,
              value: '2026-01-01',
            },
            operator: Operator.equals,
            value: 350,
          },
          dateData,
        ),
      ).toBe(true);
    });

    it('date condition — sum orders between dates', () => {
      const dateData = {
        orders: [
          { total: 100, createdAt: '2025-06-01' },
          { total: 200, createdAt: '2026-03-15' },
          { total: 150, createdAt: '2026-07-01' },
          { total: 50, createdAt: '2027-01-01' },
        ],
      };
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: {
              field: 'createdAt',
              dateOperator: DateOperator.between,
              value: ['2026-01-01', '2026-12-31'],
            },
            operator: Operator.equals,
            value: 350,
          },
          dateData,
        ),
      ).toBe(true);
    });

    it('array condition — sum orders with specific items', () => {
      const nestedData = {
        orders: [
          { total: 100, tags: [{ name: 'urgent' }, { name: 'internal' }] },
          { total: 200, tags: [{ name: 'external' }] },
          { total: 150, tags: [{ name: 'urgent' }, { name: 'external' }] },
        ],
      };
      // Sum orders that have at least one 'urgent' tag
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'sum', field: 'total' },
            condition: {
              field: 'tags',
              arrayOperator: ArrayOperator.any,
              condition: { field: 'name', operator: Operator.equals, value: 'urgent' },
            },
            operator: Operator.equals,
            value: 250,
          },
          nestedData,
        ),
      ).toBe(true);
    });

    it('array condition — avg orders with all items matching', () => {
      const nestedData = {
        orders: [
          { total: 100, items: [{ category: 'A' }, { category: 'A' }] },
          { total: 200, items: [{ category: 'A' }, { category: 'B' }] },
          { total: 300, items: [{ category: 'A' }, { category: 'A' }] },
        ],
      };
      // Avg of orders where ALL items are category A → (100 + 300) / 2 = 200
      expect(
        check(
          {
            field: 'orders',
            aggregate: { mode: 'avg', field: 'total' },
            condition: {
              field: 'items',
              arrayOperator: ArrayOperator.all,
              condition: { field: 'category', operator: Operator.equals, value: 'A' },
            },
            operator: Operator.equals,
            value: 200,
          },
          nestedData,
        ),
      ).toBe(true);
    });
  });

  describe('dot-path field traversal', () => {
    const data = {
      department: {
        projects: [
          { budget: 10000, status: 'active' },
          { budget: 5000, status: 'completed' },
          { budget: 20000, status: 'active' },
        ],
      },
    };

    it('sum through nested path', () => {
      expect(
        check(
          {
            field: 'department.projects',
            aggregate: { mode: 'sum', field: 'budget' },
            operator: Operator.equals,
            value: 35000,
          },
          data,
        ),
      ).toBe(true);
    });

    it('sum through nested path with condition', () => {
      expect(
        check(
          {
            field: 'department.projects',
            aggregate: { mode: 'sum', field: 'budget' },
            condition: { field: 'status', operator: Operator.equals, value: 'active' },
            operator: Operator.equals,
            value: 30000,
          },
          data,
        ),
      ).toBe(true);
    });
  });
});

// ─── toSql() ──────────────────────────────────────────────────────────────────

describe('toSql() aggregate rules', () => {
  it('JSONB primitive array sum', () => {
    const { sql, params } = toSql({
      field: 'tags',
      aggregate: { mode: 'sum' },
      operator: Operator.greaterThan,
      value: 100,
    });
    expect(sql).toBe(
      `(SELECT COALESCE(SUM(elem::numeric), 0) FROM jsonb_array_elements_text("tags") AS elem) > $1`,
    );
    expect(params).toEqual([100]);
  });

  it('JSONB primitive array avg', () => {
    const { sql, params } = toSql({
      field: 'scores',
      aggregate: { mode: 'avg' },
      operator: Operator.greaterThanEquals,
      value: 80,
    });
    expect(sql).toBe(
      `(SELECT AVG(elem::numeric) FROM jsonb_array_elements_text("scores") AS elem) >= $1`,
    );
    expect(params).toEqual([80]);
  });

  it('native array sum derived from map', () => {
    const { sql, params } = toSql(
      { field: 'scores', aggregate: { mode: 'sum' }, operator: Operator.greaterThan, value: 200 },
      { map: orderMap, model: 'User' },
    );
    expect(sql).toBe(`(SELECT COALESCE(SUM(elem), 0) FROM unnest("scores") AS elem) > $1`);
    expect(params).toEqual([200]);
  });

  it('JSONB object array sum via aggregate.field', () => {
    const { sql, params } = toSql({
      field: 'orders',
      aggregate: { mode: 'sum', field: 'total' },
      operator: Operator.greaterThan,
      value: 1000,
    });
    expect(sql).toBe(
      `(SELECT COALESCE(SUM((elem->>'total')::numeric), 0) FROM jsonb_array_elements("orders") AS elem) > $1`,
    );
    expect(params).toEqual([1000]);
  });

  it('between', () => {
    const { sql, params } = toSql({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: Operator.between,
      value: [100, 300],
    });
    expect(sql).toBe(
      `(SELECT COALESCE(SUM(elem::numeric), 0) FROM jsonb_array_elements_text("scores") AS elem) BETWEEN $1 AND $2`,
    );
    expect(params).toEqual([100, 300]);
  });

  it('notBetween', () => {
    const { sql, params } = toSql({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: Operator.notBetween,
      value: [100, 300],
    });
    expect(sql).toBe(
      `(SELECT COALESCE(SUM(elem::numeric), 0) FROM jsonb_array_elements_text("scores") AS elem) NOT BETWEEN $1 AND $2`,
    );
    expect(params).toEqual([100, 300]);
  });

  it('native array with aggregate.field throws', () => {
    expect(() =>
      toSql(
        {
          field: 'scores',
          aggregate: { mode: 'sum', field: 'amount' },
          operator: Operator.greaterThan,
          value: 0,
        },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow('aggregate.field is not supported for native array types');
  });

  it('condition throws — not yet supported', () => {
    expect(() =>
      toSql({
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        condition: { field: 'status', operator: Operator.equals, value: 'completed' },
        operator: Operator.greaterThan,
        value: 1000,
      }),
    ).toThrow('not yet supported by toSql()');
  });

  it('relation field throws — use toPrisma() instead', () => {
    expect(() =>
      toSql(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'total' },
          operator: Operator.greaterThan,
          value: 0,
        },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow('is a relation');
  });

  it('nested JSON array field uses JSONB extraction at leaf', () => {
    const { sql } = toSql({
      field: 'settings.scores',
      aggregate: { mode: 'sum' },
      operator: Operator.greaterThan,
      value: 0,
    });
    // Must use -> (JSONB), not ->> (text), so jsonb_array_elements_text receives a JSONB value
    expect(sql).toContain(`"settings"->'scores'`);
    expect(sql).not.toContain(`"settings"->>'scores'`);
  });

  it('field without map falls back to JSONB (no silent wrong type)', () => {
    // Without a map, fields default to JSONB — callers with native arrays must provide a map
    const { sql } = toSql({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: Operator.greaterThan,
      value: 0,
    });
    expect(sql).toContain('jsonb_array_elements_text');
  });
});

// ─── toPrisma() ───────────────────────────────────────────────────────────────

describe('toPrisma() aggregate rules', () => {
  it('sum generates groupBy step with _sum having', () => {
    const result = toPrisma(
      {
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        operator: Operator.greaterThan,
        value: 1000,
      },
      { map: orderMap, model: 'User' },
    );
    expect(result.steps).toHaveLength(2);
    const step = result.steps[0] as GroupByStep;
    expect(step.operation).toBe('groupBy');
    expect(step.model).toBe('Order');
    expect(step.args.by).toEqual(['userId']);
    expect(step.args.having).toEqual({ total: { _sum: { gt: 1000 } } });
    expect(getWhere(result)).toEqual({ id: { in: { __step: 0 } } });
  });

  it('avg generates groupBy step with _avg having', () => {
    const result = toPrisma(
      {
        field: 'orders',
        aggregate: { mode: 'avg', field: 'total' },
        operator: Operator.lessThanEquals,
        value: 500,
      },
      { map: orderMap, model: 'User' },
    );
    const step = result.steps[0] as GroupByStep;
    expect(step.args.having).toEqual({ total: { _avg: { lte: 500 } } });
  });

  it('between maps to gte/lte in having', () => {
    const result = toPrisma(
      {
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        operator: Operator.between,
        value: [100, 500],
      },
      { map: orderMap, model: 'User' },
    );
    const step = result.steps[0] as GroupByStep;
    expect(step.args.having).toEqual({ total: { _sum: { gte: 100, lte: 500 } } });
  });

  it('throws without map/model', () => {
    expect(() =>
      toPrisma({
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        operator: Operator.greaterThan,
        value: 0,
      }),
    ).toThrow('require a FieldMap and model');
  });

  it('throws without aggregate.field', () => {
    expect(() =>
      toPrisma(
        { field: 'orders', aggregate: { mode: 'sum' }, operator: Operator.greaterThan, value: 0 },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow('aggregate.field');
  });

  it('throws for notBetween', () => {
    expect(() =>
      toPrisma(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'total' },
          operator: Operator.notBetween,
          value: [0, 100],
        },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow("'notBetween' is not supported");
  });

  it('throws if field is not a relation', () => {
    expect(() =>
      toPrisma(
        {
          field: 'scores',
          aggregate: { mode: 'sum', field: 'total' },
          operator: Operator.greaterThan,
          value: 0,
        },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow('not a relation');
  });

  it('throws if aggregate.field does not exist on target model', () => {
    expect(() =>
      toPrisma(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'missing' },
          operator: Operator.greaterThan,
          value: 0,
        },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow("does not exist on model 'Order'");
  });

  it('throws if aggregate.field is not scalar on target model', () => {
    expect(() =>
      toPrisma(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'user' },
          operator: Operator.greaterThan,
          value: 0,
        },
        { map: orderMap, model: 'User' },
      ),
    ).toThrow('must be a scalar field');
  });

  describe('condition filtering', () => {
    it('adds where clause to groupBy step', () => {
      const result = toPrisma(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'total' },
          condition: { field: 'status', operator: Operator.equals, value: 'completed' },
          operator: Operator.greaterThan,
          value: 1000,
        },
        { map: orderMap, model: 'User' },
      );
      const step = result.steps[0] as GroupByStep;
      expect(step.args.where).toEqual({ status: { equals: 'completed' } });
      expect(step.args.having).toEqual({ total: { _sum: { gt: 1000 } } });
    });

    it('empty where when no condition', () => {
      const result = toPrisma(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'total' },
          operator: Operator.greaterThan,
          value: 1000,
        },
        { map: orderMap, model: 'User' },
      );
      const step = result.steps[0] as GroupByStep;
      expect(step.args.where).toEqual({});
    });

    it('compound condition (all) generates AND where', () => {
      const result = toPrisma(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'total' },
          condition: {
            all: [
              { field: 'status', operator: Operator.equals, value: 'completed' },
              { field: 'total', operator: Operator.greaterThan, value: 50 },
            ],
          },
          operator: Operator.greaterThan,
          value: 1000,
        },
        { map: orderMap, model: 'User' },
      );
      const step = result.steps[0] as GroupByStep;
      expect(step.args.where).toEqual({
        AND: [{ status: { equals: 'completed' } }, { total: { gt: 50 } }],
      });
    });
  });

  describe('dot-path field traversal', () => {
    it('walks through singular relation to list relation', () => {
      const result = toPrisma(
        {
          field: 'department.projects',
          aggregate: { mode: 'sum', field: 'budget' },
          operator: Operator.greaterThan,
          value: 10000,
        },
        { map: orderMap, model: 'User' },
      );

      expect(result.steps).toHaveLength(2);
      const step = result.steps[0] as GroupByStep;
      expect(step.operation).toBe('groupBy');
      expect(step.model).toBe('Project');
      expect(step.args.by).toEqual(['departmentId']);
      expect(step.args.having).toEqual({ budget: { _sum: { gt: 10000 } } });

      // WHERE should nest through the intermediate relation
      expect(getWhere(result)).toEqual({
        department: { id: { in: { __step: 0 } } },
      });
    });

    it('dot-path with condition filtering', () => {
      const result = toPrisma(
        {
          field: 'department.projects',
          aggregate: { mode: 'sum', field: 'budget' },
          condition: { field: 'status', operator: Operator.equals, value: 'active' },
          operator: Operator.greaterThan,
          value: 10000,
        },
        { map: orderMap, model: 'User' },
      );

      const step = result.steps[0] as GroupByStep;
      expect(step.args.where).toEqual({ status: { equals: 'active' } });
    });

    it('throws if intermediate field is a list', () => {
      expect(() =>
        toPrisma(
          {
            field: 'orders.user',
            aggregate: { mode: 'sum', field: 'total' },
            operator: Operator.greaterThan,
            value: 0,
          },
          { map: orderMap, model: 'User' },
        ),
      ).toThrow('list relation');
    });

    it('throws if terminal field is not a list', () => {
      expect(() =>
        toPrisma(
          {
            field: 'department',
            aggregate: { mode: 'sum', field: 'id' },
            operator: Operator.greaterThan,
            value: 0,
          },
          { map: orderMap, model: 'User' },
        ),
      ).toThrow('not a list relation');
    });
  });
});

// ─── validateRule() ───────────────────────────────────────────────────────────

describe('validateRule() aggregate rules', () => {
  it('valid primitive sum rule', () => {
    expect(
      validateRule({
        field: 'scores',
        aggregate: { mode: 'sum' },
        operator: Operator.greaterThan,
        value: 100,
      }).ok,
    ).toBe(true);
  });

  it('valid object sum rule', () => {
    expect(
      validateRule({
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        operator: Operator.greaterThan,
        value: 100,
      }).ok,
    ).toBe(true);
  });

  it('valid between rule', () => {
    expect(
      validateRule({
        field: 'scores',
        aggregate: { mode: 'avg' },
        operator: Operator.between,
        value: [50, 100],
      }).ok,
    ).toBe(true);
  });

  it('invalid mode', () => {
    const result = validateRule({
      field: 'scores',
      aggregate: { mode: 'count' },
      operator: Operator.greaterThan,
      value: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('invalid_aggregate_mode');
  });

  it('unsupported operator', () => {
    const result = validateRule({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: Operator.contains,
      value: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('invalid_aggregate_operator');
  });

  it('missing value and path', () => {
    const result = validateRule({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: Operator.greaterThan,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('missing_value_source');
  });

  it('between requires range value', () => {
    const result = validateRule({
      field: 'scores',
      aggregate: { mode: 'sum' },
      operator: Operator.between,
      value: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('invalid_range_value');
  });

  it('toPrisma rejects notBetween', () => {
    const result = validateRule(
      {
        field: 'scores',
        aggregate: { mode: 'sum' },
        operator: Operator.notBetween,
        value: [0, 100],
      },
      { target: 'toPrisma' },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('unsupported_prisma_aggregate_operator');
  });

  it('toPrisma rejects path', () => {
    const result = validateRule(
      {
        field: 'scores',
        aggregate: { mode: 'sum' },
        operator: Operator.greaterThan,
        path: 'minScore',
      },
      { target: 'toPrisma' },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('unsupported_prisma_aggregate_path');
  });

  it('valid aggregate with condition', () => {
    expect(
      validateRule({
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        condition: { field: 'status', operator: Operator.equals, value: 'completed' },
        operator: Operator.greaterThan,
        value: 100,
      }).ok,
    ).toBe(true);
  });

  it('invalid condition is reported', () => {
    const result = validateRule({
      field: 'orders',
      aggregate: { mode: 'sum', field: 'total' },
      condition: { field: 'status', operator: 'bogus', value: 'x' },
      operator: Operator.greaterThan,
      value: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toContain('condition');
  });

  it('toSql rejects condition', () => {
    const result = validateRule(
      {
        field: 'orders',
        aggregate: { mode: 'sum', field: 'total' },
        condition: { field: 'status', operator: Operator.equals, value: 'completed' },
        operator: Operator.greaterThan,
        value: 100,
      },
      { target: 'toSql' },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('unsupported_sql_aggregate_condition');
  });

  it('toPrisma accepts condition', () => {
    expect(
      validateRule(
        {
          field: 'orders',
          aggregate: { mode: 'sum', field: 'total' },
          condition: { field: 'status', operator: Operator.equals, value: 'completed' },
          operator: Operator.greaterThan,
          value: 100,
        },
        { target: 'toPrisma' },
      ).ok,
    ).toBe(true);
  });
});
