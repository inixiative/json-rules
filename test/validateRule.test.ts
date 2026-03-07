import { describe, expect, test } from 'bun:test';
import {
  ArrayOperator,
  assertValidRule,
  DateOperator,
  Operator,
  type StrictCondition,
  validateRule,
} from '../index';

describe('validateRule', () => {
  test('accepts a valid runtime rule', () => {
    const result = validateRule({
      all: [
        { field: 'status', operator: Operator.equals, value: 'active' },
        {
          field: 'orders',
          arrayOperator: ArrayOperator.all,
          condition: {
            field: 'total',
            operator: Operator.lessThanEquals,
            path: '$.maxBudget',
          },
        },
      ],
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('rejects invalid field range shape', () => {
    const result = validateRule({
      field: 'age',
      operator: Operator.between,
      value: 18,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid_range_value');
  });

  test('rejects no-value operators with value', () => {
    const result = validateRule({
      field: 'name',
      operator: Operator.exists,
      value: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain('unexpected_value');
  });

  test('rejects mixed condition shapes', () => {
    const result = validateRule({
      all: [],
      field: 'status',
      operator: Operator.equals,
      value: 'active',
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('ambiguous_condition');
  });

  test('rejects missing count for runtime count operators', () => {
    const result = validateRule({
      field: 'posts',
      arrayOperator: ArrayOperator.atLeast,
      condition: { field: 'published', operator: Operator.equals, value: true },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain('missing_count');
  });

  test('allows missing count for toPrisma count operators', () => {
    const result = validateRule(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.atLeast,
      },
      { target: 'toPrisma' },
    );

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('rejects prisma-incompatible operators', () => {
    const result = validateRule(
      {
        field: 'email',
        operator: Operator.matches,
        value: /@example\.com$/,
      },
      { target: 'toPrisma' },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('unsupported_prisma_operator');
  });

  test('rejects prisma-incompatible date path comparisons', () => {
    const result = validateRule(
      {
        field: 'endDate',
        dateOperator: DateOperator.after,
        path: '$.startDate',
      },
      { target: 'toPrisma' },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain('unsupported_prisma_path');
  });

  test('rejects sql-incompatible array operators', () => {
    const result = validateRule(
      {
        field: 'orders',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'total', operator: Operator.greaterThan, value: 0 },
      },
      { target: 'toSql' },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('unsupported_sql_array_operator');
  });

  test('assertValidRule throws a readable error', () => {
    expect(() =>
      assertValidRule({
        field: 'deliveryDate',
        dateOperator: DateOperator.dayIn,
        value: 'monday',
      }),
    ).toThrow('Invalid rule');
  });
});

describe('StrictCondition type coverage', () => {
  const validFieldRule: StrictCondition = {
    field: 'name',
    operator: Operator.startsWith,
    value: 'A',
  };

  const validPresenceRule: StrictCondition = {
    field: 'name',
    operator: Operator.exists,
  };

  const validDateRule: StrictCondition = {
    field: 'eventDate',
    dateOperator: DateOperator.between,
    value: [new Date('2024-01-01'), new Date('2024-12-31')],
  };

  test('typed samples compile and remain usable at runtime', () => {
    expect(validFieldRule).toBeTruthy();
    expect(validPresenceRule).toBeTruthy();
    expect(validDateRule).toBeTruthy();
  });

  const invalidBetweenRule = {
    field: 'age',
    operator: Operator.between,
    // @ts-expect-error between requires a two-item range or a path
    value: 18,
  } satisfies StrictCondition;

  const invalidStartsWithRule = {
    field: 'name',
    operator: Operator.startsWith,
    // @ts-expect-error startsWith requires a string value or a path
    value: 123,
  } satisfies StrictCondition;

  const invalidDayPathRule = {
    field: 'deliveryDate',
    dateOperator: DateOperator.dayIn,
    // @ts-expect-error dayIn does not accept path
    path: 'schedule.allowedDays',
  } satisfies StrictCondition;

  test('ts-expect-error fixtures are retained for typecheck', () => {
    expect(invalidBetweenRule).toBeDefined();
    expect(invalidStartsWithRule).toBeDefined();
    expect(invalidDayPathRule).toBeDefined();
  });
});
