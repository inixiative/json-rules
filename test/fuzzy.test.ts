import { afterEach, describe, expect, test } from 'bun:test';
import { check, engineGlobals, Operator, toPrisma, toSql } from '../index';

describe('fuzzy flag — in-memory check()', () => {
  const row = { name: 'Acme Payroll Cloud' };

  test('exact contains still matches without fuzzy', () => {
    expect(check({ field: 'name', operator: Operator.contains, value: 'Payroll' }, row)).toBe(true);
  });

  test('typo does not match without fuzzy', () => {
    expect(check({ field: 'name', operator: Operator.contains, value: 'payrll' }, row)).not.toBe(
      true,
    );
  });

  test('typo matches with fuzzy:true (default curve, case-insensitive)', () => {
    expect(
      check({ field: 'name', operator: Operator.contains, value: 'payrll', fuzzy: true }, row),
    ).toBe(true);
    expect(
      check({ field: 'name', operator: Operator.contains, value: 'PAYRLL', fuzzy: true }, row),
    ).toBe(true);
  });

  test('notContains inverts the fuzzy match', () => {
    expect(
      check({ field: 'name', operator: Operator.notContains, value: 'payrll', fuzzy: true }, row),
    ).not.toBe(true);
    expect(
      check({ field: 'name', operator: Operator.notContains, value: 'oracle', fuzzy: true }, row),
    ).toBe(true);
  });

  test('maxDistance and maxRatio are both caps — the tighter wins', () => {
    const longRow = { name: 'internationalization' };
    // ratio 0.2 → 4 edits allowed, but maxDistance caps at 1 → "internationaliztaion" (2 transposed edits) fails
    expect(
      check(
        {
          field: 'name',
          operator: Operator.contains,
          value: 'intarnationalization',
          fuzzy: { maxRatio: 0.2, maxDistance: 1 },
        },
        longRow,
      ),
    ).toBe(true);
    expect(
      check(
        {
          field: 'name',
          operator: Operator.contains,
          value: 'intarnaXionalization',
          fuzzy: { maxRatio: 0.2, maxDistance: 1 },
        },
        longRow,
      ),
    ).not.toBe(true);
  });

  test('numeric tokens are identity — never typo-corrected', () => {
    expect(
      check(
        { field: 'name', operator: Operator.contains, value: '2024', fuzzy: true },
        { name: 'Order 2025' },
      ),
    ).not.toBe(true);
  });
});

describe('fuzzy — engine-global default via with()', () => {
  const row = { name: 'Acme Payroll Cloud' };
  afterEach(() => engineGlobals.reset());

  test('with() scopes fuzzy for a synchronous pass, then restores', () => {
    const matched = engineGlobals.with({ string: { fuzzy: true } }, () =>
      check({ field: 'name', operator: Operator.contains, value: 'payrll' }, row),
    );
    expect(matched).toBe(true);
    // restored: no global fuzzy after the block
    expect(check({ field: 'name', operator: Operator.contains, value: 'payrll' }, row)).not.toBe(
      true,
    );
  });

  test('with() restores even when the callback throws', () => {
    expect(() =>
      engineGlobals.with({ string: { fuzzy: true } }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(engineGlobals.get('string.fuzzy')).toBe(false);
  });

  test('with() rejects an async callback', () => {
    expect(() => engineGlobals.with({ string: { fuzzy: true } }, () => Promise.resolve(1))).toThrow(
      /must be synchronous/,
    );
  });
});

describe('fuzzy — unsupported in compilers', () => {
  test('toPrisma throws on a fuzzy rule', () => {
    expect(() =>
      toPrisma({ field: 'name', operator: Operator.contains, value: 'x', fuzzy: true }),
    ).toThrow(/no Prisma equivalent/);
  });

  test('toSql throws on a fuzzy rule', () => {
    expect(() =>
      toSql({ field: 'name', operator: Operator.contains, value: 'x', fuzzy: true }),
    ).toThrow(/no SQL equivalent/);
  });
});
