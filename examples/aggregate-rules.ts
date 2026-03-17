import { Operator, check, toPrisma, toSql } from '../index';

// ─── check() ──────────────────────────────────────────────────────────────────

// Primitive numeric array — sum
const highScoreRule = {
  field: 'scores',
  aggregate: { mode: 'sum' as const },
  operator: Operator.greaterThan,
  value: 200,
};

console.log(check(highScoreRule, { scores: [80, 90, 70] })); // true  (sum = 240)
console.log(check(highScoreRule, { scores: [50, 60, 70] })); // "scores sum must be greater than 200"

// Primitive numeric array — avg
const avgScoreRule = {
  field: 'scores',
  aggregate: { mode: 'avg' as const },
  operator: Operator.greaterThanEquals,
  value: 80,
};

console.log(check(avgScoreRule, { scores: [80, 90, 70] })); // true  (avg = 80)
console.log(check(avgScoreRule, { scores: [60, 70, 75] })); // "scores avg must be greater than or equal to 80"

// Empty array: sum([]) = 0, avg([]) fails
console.log(check(highScoreRule, { scores: [] })); // "scores sum must be greater than 200"  (0 > 200 is false)
console.log(check({ field: 'scores', aggregate: { mode: 'sum' as const }, operator: Operator.equals, value: 0 }, { scores: [] })); // true

// Object array — aggregate.field selects the numeric property per element
const orderValueRule = {
  field: 'orders',
  aggregate: { mode: 'sum' as const, field: 'total' },
  operator: Operator.greaterThan,
  value: 500,
  error: 'Total order value must exceed 500',
};

console.log(
  check(orderValueRule, {
    orders: [{ total: 200 }, { total: 150 }, { total: 200 }],
  }),
); // true  (sum = 550)

console.log(
  check(orderValueRule, {
    orders: [{ total: 100 }, { total: 150 }],
  }),
); // "Total order value must exceed 500"

// Path reference on RHS
const budgetRule = {
  field: 'orders',
  aggregate: { mode: 'sum' as const, field: 'total' },
  operator: Operator.lessThanEquals,
  path: 'budget',
};

console.log(
  check(budgetRule, {
    orders: [{ total: 100 }, { total: 200 }],
    budget: 400,
  }),
); // true  (sum 300 <= budget 400)

// ─── toSql() ──────────────────────────────────────────────────────────────────

// JSONB primitive array (default when no map provided)
const { sql: sql1, params: p1 } = toSql({
  field: 'scores',
  aggregate: { mode: 'avg' },
  operator: Operator.greaterThanEquals,
  value: 80,
});
console.log(sql1);
// (SELECT AVG(elem::numeric) FROM jsonb_array_elements_text("scores") AS elem) >= $1
console.log(p1); // [80]

// JSONB object array
const { sql: sql2, params: p2 } = toSql({
  field: 'orders',
  aggregate: { mode: 'sum', field: 'total' },
  operator: Operator.greaterThan,
  value: 1000,
});
console.log(sql2);
// (SELECT COALESCE(SUM((elem->>'total')::numeric), 0) FROM jsonb_array_elements("orders") AS elem) > $1
console.log(p2); // [1000]

// ─── toPrisma() ───────────────────────────────────────────────────────────────
// Requires map + model — see README for executePrismaQueryPlan usage

const plan = toPrisma(
  {
    field: 'orders',
    aggregate: { mode: 'sum', field: 'total' },
    operator: Operator.greaterThan,
    value: 1000,
  },
  {
    map: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          orders: { kind: 'object', type: 'Order', isList: true, fromFields: [], toFields: [] },
        },
      },
      Order: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          total: { kind: 'scalar', type: 'Float' },
          userId: { kind: 'scalar', type: 'String' },
          user: { kind: 'object', type: 'User', isList: false, fromFields: ['userId'], toFields: ['id'] },
        },
      },
    },
    model: 'User',
  },
);

console.log(JSON.stringify(plan, null, 2));
// {
//   "steps": [
//     {
//       "operation": "groupBy",
//       "model": "Order",
//       "args": { "by": ["userId"], "where": {}, "having": { "_sum": { "total": { "gt": 1000 } } } },
//       "extract": "userId"
//     },
//     {
//       "operation": "where",
//       "where": { "id": { "in": { "__step": 0 } } }
//     }
//   ]
// }
