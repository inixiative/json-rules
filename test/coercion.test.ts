import { describe, expect, test } from 'bun:test';
import type { Condition, Rule } from '../index';
import { ArrayOperator, check, createLens, Operator, stampCoercions, validateRule } from '../index';

describe('coerceType — check()', () => {
  describe('DateTime', () => {
    const row = { createdAt: '2026-06-01T00:00:00.000Z' };

    test('without coerceType, Date value vs ISO field stays strict (baseline)', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.greaterThan,
        value: new Date('2026-01-01'),
      };
      expect(check(rule, row)).not.toBe(true);
    });

    test('Date object value compares against ISO string field', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.greaterThan,
        value: new Date('2026-01-01'),
        coerceType: 'DateTime',
      };
      expect(check(rule, row)).toBe(true);
    });

    test('equals across formats of the same instant', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.equals,
        value: '2026-06-01T00:00:00Z',
        coerceType: 'DateTime',
      };
      expect(check(rule, row)).toBe(true);
    });

    test('non-UTC offset value compares chronologically', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.lessThan,
        value: '2026-06-01T09:00:00+09:00',
        coerceType: 'DateTime',
      };
      // field is midnight UTC; value is 09:00+09:00 = midnight UTC → not less
      expect(check(rule, row)).not.toBe(true);
      const gte: Rule = { ...rule, operator: Operator.greaterThanEquals };
      expect(check(gte, row)).toBe(true);
    });

    test('date-only bound includes the boundary midnight', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.lessThanEquals,
        value: '2026-06-01',
        coerceType: 'DateTime',
      };
      expect(check(rule, row)).toBe(true);
    });

    test('between with mixed Date and date-only bounds', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.between,
        value: [new Date('2026-05-01'), '2026-06-01'],
        coerceType: 'DateTime',
      };
      expect(check(rule, row)).toBe(true);
    });

    test('ms-timestamp string value', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.equals,
        value: String(Date.parse('2026-06-01T00:00:00.000Z')),
        coerceType: 'DateTime',
      };
      expect(check(rule, row)).toBe(true);
    });

    test('unparseable field value fails the comparison without throwing', () => {
      const rule: Rule = {
        field: 'createdAt',
        operator: Operator.greaterThan,
        value: '2026-01-01',
        coerceType: 'DateTime',
      };
      expect(check(rule, { createdAt: 'not-a-date' })).not.toBe(true);
    });

    test('null field value passes through untouched', () => {
      const rule: Rule = { field: 'createdAt', operator: Operator.isEmpty, coerceType: 'DateTime' };
      expect(check(rule, { createdAt: null })).toBe(true);
    });
  });

  describe('numeric kinds', () => {
    test('stringified number equals number field', () => {
      const rule: Rule = {
        field: 'price',
        operator: Operator.equals,
        value: '5',
        coerceType: 'Int',
      };
      expect(check(rule, { price: 5 })).toBe(true);
    });

    test('in-list of stringified numbers matches number field', () => {
      const rule: Rule = {
        field: 'price',
        operator: Operator.in,
        value: ['1', '2', '3'],
        coerceType: 'Int',
      };
      expect(check(rule, { price: 2 })).toBe(true);
    });

    test('Float coerces decimals', () => {
      const rule: Rule = {
        field: 'rate',
        operator: Operator.greaterThan,
        value: '1.5',
        coerceType: 'Float',
      };
      expect(check(rule, { rate: 2.25 })).toBe(true);
    });

    test('non-numeric string stays unchanged and fails', () => {
      const rule: Rule = {
        field: 'price',
        operator: Operator.equals,
        value: 'abc',
        coerceType: 'Int',
      };
      expect(check(rule, { price: 5 })).not.toBe(true);
    });
  });

  describe('Boolean', () => {
    test("'true' string equals boolean field", () => {
      const rule: Rule = {
        field: 'isActive',
        operator: Operator.equals,
        value: 'true',
        coerceType: 'Boolean',
      };
      expect(check(rule, { isActive: true })).toBe(true);
    });

    test("'false' string equals boolean field", () => {
      const rule: Rule = {
        field: 'isActive',
        operator: Operator.notEquals,
        value: 'false',
        coerceType: 'Boolean',
      };
      expect(check(rule, { isActive: true })).toBe(true);
    });
  });

  describe('String', () => {
    test('number field equals its stringified option value', () => {
      const rule: Rule = {
        field: 'level',
        operator: Operator.equals,
        value: '3',
        coerceType: 'String',
      };
      expect(check(rule, { level: 3 })).toBe(true);
    });
  });
});

describe('coerceType — validateRule', () => {
  test('accepts a valid kind', () => {
    const rule: Rule = { field: 'a', operator: Operator.equals, value: '1', coerceType: 'Int' };
    expect(validateRule(rule).ok).toBe(true);
  });

  test('rejects an unknown kind', () => {
    const rule = {
      field: 'a',
      operator: Operator.equals,
      value: '1',
      coerceType: 'int',
    } as unknown as Rule;
    const result = validateRule(rule);
    expect(result.ok).toBe(false);
    expect(result.errors.some((i) => i.code === 'invalid_coerce_type')).toBe(true);
  });
});

describe('stampCoercions', () => {
  const lens = createLens({
    mapName: 'sdk',
    model: 'Reward',
    maps: {
      sdk: {
        models: {
          Reward: {
            fields: {
              name: { kind: 'scalar', type: 'String' },
              price: { kind: 'scalar', type: 'Int' },
              createdAt: { kind: 'scalar', type: 'DateTime' },
              isActive: { kind: 'scalar', type: 'Boolean' },
              meta: { kind: 'scalar', type: 'Json' },
              status: { kind: 'enum', type: 'Reward.status', values: ['draft', 'live'] },
              brand: { kind: 'object', type: 'Brand' },
              tags: { kind: 'object', type: 'Tag', isList: true },
            },
          },
          Brand: { fields: { tier: { kind: 'scalar', type: 'Int' } } },
          Tag: { fields: { label: { kind: 'scalar', type: 'String' } } },
        },
      },
    },
  });

  test('stamps scalar kinds on field rules', () => {
    const stamped = stampCoercions(
      { field: 'createdAt', operator: Operator.greaterThan, value: '2026-01-01' },
      lens,
    ) as Rule;
    expect(stamped.coerceType).toBe('DateTime');
  });

  test('leaves enum and Json fields unstamped', () => {
    const enumRule = stampCoercions(
      { field: 'status', operator: Operator.equals, value: 'live' },
      lens,
    ) as Rule;
    expect(enumRule.coerceType).toBeUndefined();
    const jsonRule = stampCoercions({ field: 'meta', operator: Operator.exists }, lens) as Rule;
    expect(jsonRule.coerceType).toBeUndefined();
  });

  test('walks all/any/if and dotted relation paths', () => {
    const stamped = stampCoercions(
      {
        all: [
          { field: 'brand.tier', operator: Operator.greaterThan, value: '2' },
          {
            any: [{ field: 'isActive', operator: Operator.equals, value: 'true' }],
          },
          {
            if: { field: 'price', operator: Operator.greaterThan, value: '0' },
            then: { field: 'name', operator: Operator.notEmpty },
          },
        ],
      },
      lens,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test traversal
    const tree = stamped as any;
    expect(tree.all[0].coerceType).toBe('Int');
    expect(tree.all[1].any[0].coerceType).toBe('Boolean');
    expect(tree.all[2].if.coerceType).toBe('Int');
  });

  test('array rule nested condition stamps against the item model', () => {
    const stamped = stampCoercions(
      {
        field: 'tags',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'label', operator: Operator.equals, value: 5 },
      },
      lens,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test traversal
    expect((stamped as any).condition.coerceType).toBe('String');
  });

  test('preserves an existing coerceType and unknown fields', () => {
    const existing: Condition = {
      field: 'price',
      operator: Operator.equals,
      value: '1',
      coerceType: 'String',
    };
    expect((stampCoercions(existing, lens) as Rule).coerceType).toBe('String');
    const unknown = stampCoercions(
      { field: 'nope', operator: Operator.equals, value: 1 },
      lens,
    ) as Rule;
    expect(unknown.coerceType).toBeUndefined();
  });

  test('stamped rule round-trips through check()', () => {
    const stamped = stampCoercions(
      { field: 'price', operator: Operator.in, value: ['3', '5'] },
      lens,
    );
    expect(check(stamped, { price: 5 })).toBe(true);
  });
});
