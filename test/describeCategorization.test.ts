import { describe, expect, test } from 'bun:test';
import {
  AGGREGATE_MODES,
  aggregateModesForKind,
  type Categorization,
  createLens,
  describeCategorization,
  type FieldMapSet,
  getOperatorsForKind,
  listItems,
  Operator,
  validateRule,
  valueExpressionShape,
} from '../index';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      Account: {
        fields: {
          tier: { kind: 'scalar', type: 'String', isRequired: true },
          seats: { kind: 'scalar', type: 'Int', isRequired: true },
          arr: { kind: 'scalar', type: 'Decimal' },
          renewedAt: { kind: 'scalar', type: 'DateTime' },
          deals: {
            kind: 'object',
            type: 'Deal',
            isList: true,
            relationName: 'Deal',
            fromFields: [],
            toFields: [],
          },
        },
      },
      Deal: {
        fields: {
          amount: { kind: 'scalar', type: 'Float', isRequired: true },
          stage: { kind: 'scalar', type: 'String', isRequired: true },
        },
      },
    },
  },
};

const lens = {
  parent: createLens({ maps, mapName: 'app', model: 'Account' }),
  root: { relations: { deals: {} } },
};

const big = { field: 'seats', operator: Operator.greaterThan, value: 100 };
const small = { field: 'seats', operator: Operator.lessThan, value: 10 };

describe('describeCategorization', () => {
  test('first match: the cases and the default unify to one type', () => {
    const tiers: Categorization = {
      cases: [
        { if: big, then: 'enterprise' },
        { if: small, then: { path: 'tier' } },
      ],
      default: 'standard',
    };
    expect(describeCategorization(tiers, lens)).toEqual({
      type: { kind: 'String', isList: false, nullable: false },
      paths: ['seats', 'tier'],
      clockUnit: null,
      errors: [],
    });
  });

  test('first match with no default is nullable', () => {
    const noDefault: Categorization = { cases: [{ if: big, then: 1 }] };
    expect(describeCategorization(noDefault, lens).type).toEqual({
      kind: 'Int',
      isList: false,
      nullable: true,
    });
  });

  test('numbers across cases read as one numeric kind, as unify reads them', () => {
    const value: Categorization = {
      cases: [{ if: big, then: { path: 'arr' } }],
      default: 0,
    };
    expect(describeCategorization(value, lens).type?.kind).toBe('Decimal');
  });

  test('match: all is a list of the case values', () => {
    const labels: Categorization = {
      cases: [
        { if: big, then: 'large' },
        { if: small, then: 'small' },
      ],
      match: 'all',
      default: 'mid',
    };
    expect(describeCategorization(labels, lens).type).toEqual({
      kind: 'String',
      isList: true,
      nullable: false,
    });
  });

  test('cases of different kinds are reported at the case that disagrees', () => {
    const mixed: Categorization = {
      cases: [
        { if: big, then: 'enterprise' },
        { if: small, then: { path: 'seats' } },
      ],
    };
    const described = describeCategorization(mixed, lens);
    expect(described.type).toBeNull();
    expect(described.errors).toEqual([
      expect.objectContaining({ path: '$.cases[1].then', code: 'value_type_mismatch' }),
    ]);
  });

  test("a case's condition and value are each gated in the lens, at their case", () => {
    const outside: Categorization = {
      cases: [
        { if: { field: 'missing', operator: Operator.equals, value: 1 }, then: { path: 'nope' } },
      ],
    };
    const paths = describeCategorization(outside, lens).errors.map((issue) => issue.path);
    expect(paths).toContain('$.cases[0].if.missing');
    expect(paths.some((path) => path.startsWith('$.cases[0].then'))).toBe(true);
  });

  test('a computed value: an aggregate over a to-many relation', () => {
    const pipeline: Categorization = {
      cases: [
        {
          if: big,
          then: { field: 'deals', aggregate: { mode: 'sum', field: 'amount' } },
        },
      ],
      default: 0,
    };
    const described = describeCategorization(pipeline, lens);
    expect(described.errors).toEqual([]);
    expect(described.type?.kind).toBe('Float');
    expect(described.paths).toContain('deals.amount');
  });

  test('under match: all a list value is refused: categorize returns one list', () => {
    const nested: Categorization = {
      cases: [{ if: big, then: ['a', 'b'] }],
      match: 'all',
    };
    expect(describeCategorization(nested, lens).errors).toEqual([
      expect.objectContaining({ path: '$.cases[0].then', code: 'nested_list' }),
    ]);
  });

  test('a malformed categorization reports its shape issues and nothing else', () => {
    const described = describeCategorization({ cases: 'no' } as never, lens);
    expect(described.type).toBeNull();
    expect(described.errors.map((issue) => issue.code)).toEqual(['invalid_cases']);
  });
});

describe('the catalog lookups a builder reads', () => {
  test('aggregateModesForKind follows what each mode reads', () => {
    expect(aggregateModesForKind('Float')).toEqual([
      'sum',
      'avg',
      'count',
      'min',
      'max',
      'distinct',
      'pick',
    ]);
    expect(aggregateModesForKind('String')).toEqual(['count', 'distinct', 'pick']);
    expect(aggregateModesForKind('DateTime')).toEqual(['count', 'min', 'max', 'distinct', 'pick']);
    expect(aggregateModesForKind('Json')).toEqual(['count', 'pick']);
    expect(aggregateModesForKind('Int', { comparable: true })).toEqual([...AGGREGATE_MODES]);
    // A pick compares in check() only: the compiled rails take sum and avg.
    expect(aggregateModesForKind('Int', { comparable: true, compiled: true })).toEqual([
      'sum',
      'avg',
    ]);
    expect(aggregateModesForKind('String', { comparable: true })).toEqual(['pick']);
  });

  test('getOperatorsForKind with positive: true offers only what validateRule({ positive }) admits', () => {
    const { field, date } = getOperatorsForKind('String', undefined, { positive: true });
    expect(field).not.toContain(Operator.notEquals);
    expect(field).not.toContain(Operator.isEmpty);
    expect(field).toContain(Operator.equals);
    for (const operator of field) {
      const rule = { field: 'tier', operator, value: 'x' };
      const refusedForPositivity = validateRule(rule, { positive: true }).errors.some(
        (issue) => issue.code === 'notPositive',
      );
      expect(refusedForPositivity).toBe(false);
    }
    expect(date.length).toBeGreaterThanOrEqual(0);
    expect(getOperatorsForKind('String').field).toContain(Operator.notEquals);
  });

  test('valueExpressionShape and listItems read a value as the evaluator does', () => {
    expect(valueExpressionShape(5)).toBe('literal');
    expect(valueExpressionShape({ path: 'tier' })).toBe('source');
    expect(valueExpressionShape({ if: true, then: 1 })).toBe('if');
    expect(valueExpressionShape({ list: [1], distinct: true })).toBe('list');
    expect(listItems({ list: [1, 2], distinct: true })).toEqual([1, 2]);
    expect(listItems([3])).toEqual([3]);
  });
});
