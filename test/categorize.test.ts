import { describe, expect, test } from 'bun:test';
import {
  assertValidCategorization,
  type Categorization,
  categorize,
  Operator,
  validateCategorization,
} from '../index';

const tier: Categorization = {
  cases: [
    { if: { field: 'deals', operator: Operator.greaterThanEquals, value: 10 }, then: 'gold' },
    { if: { field: 'deals', operator: Operator.greaterThanEquals, value: 3 }, then: 'silver' },
  ],
  default: 'bronze',
};

describe('categorize, first match (the default)', () => {
  test('a row matching two cases takes only the first', () => {
    expect(categorize(tier, { deals: 12 })).toBe('gold');
    expect(categorize(tier, { deals: 4 })).toBe('silver');
  });

  test('a row matching none takes the default, or null with none', () => {
    expect(categorize(tier, { deals: 1 })).toBe('bronze');
    expect(categorize({ cases: tier.cases }, { deals: 1 })).toBeNull();
  });

  test('a value is a value expression: a field/value map, or read from the row', () => {
    const close: Categorization = {
      cases: [
        {
          if: {
            field: 'status',
            operator: Operator.notIn,
            value: ['approved', 'denied', 'canceled'],
          },
          then: { value: { status: 'canceled', expiresAt: null } },
        },
      ],
    };
    expect(categorize(close, { status: 'sent' })).toEqual({ status: 'canceled', expiresAt: null });
    expect(categorize(close, { status: 'approved' })).toBeNull();
    expect(
      categorize(
        { cases: [{ if: { field: 'name', operator: Operator.notEmpty }, then: { path: 'name' } }] },
        { name: 'Ada' },
      ),
    ).toBe('Ada');
  });

  test('later cases are not checked once one holds', () => {
    const later: Categorization = {
      cases: [
        { if: { field: 'deals', operator: Operator.greaterThanEquals, value: 10 }, then: 'gold' },
        { if: { field: 'deals', operator: Operator.equals, bind: 'never' }, then: 'x' },
      ],
    };
    expect(categorize(later, { deals: 12 })).toBe('gold');
    expect(() => categorize(later, { deals: 1 })).toThrow();
  });

  test('a case that throws stops: it never falls through to a later case or the default', () => {
    const broken: Categorization = {
      cases: [
        {
          if: { field: 'deals', operator: Operator.equals, bind: 'missing' },
          then: 'x',
        },
        { if: { field: 'deals', operator: Operator.greaterThanEquals, value: 0 }, then: 'y' },
      ],
      default: 'z',
    };
    expect(() => categorize(broken, { deals: 1 })).toThrow();
  });

  test("check()'s options reach every case and value", () => {
    const bound: Categorization = {
      cases: [
        {
          if: { field: 'deals', operator: Operator.greaterThanEquals, bind: 'floor' },
          then: { bind: 'label' },
        },
      ],
    };
    expect(categorize(bound, { deals: 5 }, { bindings: { floor: 5, label: 'met' } })).toBe('met');
  });
});

describe("categorize, match: 'all'", () => {
  test('every case that holds, in case order', () => {
    expect(categorize({ ...tier, match: 'all' }, { deals: 12 })).toEqual(['gold', 'silver']);
    expect(categorize({ ...tier, match: 'all' }, { deals: 4 })).toEqual(['silver']);
  });

  test('none holding takes a list of the default, or [] with none', () => {
    expect(categorize({ ...tier, match: 'all' }, { deals: 1 })).toEqual(['bronze']);
    expect(categorize({ cases: tier.cases, match: 'all' }, { deals: 1 })).toEqual([]);
  });
});

describe('validateCategorization', () => {
  test('accepts a well-formed categorization', () => {
    expect(validateCategorization(tier)).toEqual({ ok: true, errors: [] });
    expect(validateCategorization({ ...tier, match: 'all' }).ok).toBe(true);
    expect(validateCategorization({ cases: [] }).ok).toBe(true);
  });

  test('names each problem by its path', () => {
    const codes = (input: unknown) =>
      validateCategorization(input).errors.map(({ path, code }) => `${path} ${code}`);
    expect(codes(null)).toEqual(['$ invalid_categorization']);
    expect(codes({ cases: 'nope' })).toEqual(['$.cases invalid_cases']);
    expect(codes({ cases: [], match: 'some' })).toEqual(['$.match invalid_match']);
    expect(codes({ cases: [], else: 'x' })).toEqual(['$.else unknown_key']);
    expect(codes({ cases: [{ then: 'x' }] })).toEqual(['$.cases[0].if condition_required']);
    expect(codes({ cases: [{ if: { field: 'a', operator: 'equals', value: 1 } }] })).toEqual([
      '$.cases[0].then value_required',
    ]);
    expect(codes({ cases: ['x'] })).toEqual(['$.cases[0] invalid_case']);
    expect(
      codes({
        cases: [{ if: { field: 'a', operator: 'equals', value: 1 }, then: 'x', else: 'y' }],
      }),
    ).toEqual(['$.cases[0].else unknown_key']);
  });

  test('checks each if as validateRule does and each value as validateValue does', () => {
    const result = validateCategorization({
      cases: [{ if: { field: 'a', operator: 'nope', value: 1 }, then: 'x' }],
      default: { path: 'a', value: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.path.startsWith('$.cases[0].if'))).toBe(true);
    expect(result.errors.some((issue) => issue.path.startsWith('$.default'))).toBe(true);
  });

  test('assertValidCategorization throws the issues', () => {
    expect(() => assertValidCategorization({ cases: 'nope' })).toThrow('Invalid categorization');
    expect(() => assertValidCategorization(tier)).not.toThrow();
  });
});
