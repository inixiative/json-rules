import { describe, expect, test } from 'bun:test';
import { check, Operator, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

describe('caseInsensitive flag — in-memory check()', () => {
  const row = { name: 'Cisco Systems' };

  test('default (case-sensitive) does not match differing case', () => {
    expect(check({ field: 'name', operator: Operator.contains, value: 'cisco' }, row)).not.toBe(
      true,
    );
    expect(
      check({ field: 'name', operator: Operator.equals, value: 'cisco systems' }, row),
    ).not.toBe(true);
  });

  test('caseInsensitive:true matches differing case', () => {
    expect(
      check(
        { field: 'name', operator: Operator.contains, value: 'cisco', caseInsensitive: true },
        row,
      ),
    ).toBe(true);
    expect(
      check(
        { field: 'name', operator: Operator.equals, value: 'cisco systems', caseInsensitive: true },
        row,
      ),
    ).toBe(true);
    expect(
      check(
        { field: 'name', operator: Operator.notContains, value: 'oracle', caseInsensitive: true },
        row,
      ),
    ).toBe(true);
    expect(
      check(
        {
          field: 'name',
          operator: Operator.notEquals,
          value: 'cisco systems',
          caseInsensitive: true,
        },
        row,
      ),
    ).not.toBe(true);
    expect(
      check(
        { field: 'name', operator: Operator.startsWith, value: 'cisco', caseInsensitive: true },
        row,
      ),
    ).toBe(true);
    expect(
      check(
        { field: 'name', operator: Operator.endsWith, value: 'SYSTEMS', caseInsensitive: true },
        row,
      ),
    ).toBe(true);
  });

  test('caseInsensitive:true is a no-op on non-string operands', () => {
    expect(
      check(
        { field: 'age', operator: Operator.equals, value: 30, caseInsensitive: true },
        { age: 30 },
      ),
    ).toBe(true);
  });
});

describe('caseInsensitive flag — toPrisma', () => {
  test('caseInsensitive:true emits mode:insensitive', () => {
    expect(
      getWhere(
        toPrisma({
          field: 'name',
          operator: Operator.contains,
          value: 'cisco',
          caseInsensitive: true,
        }),
      ),
    ).toEqual({
      name: { contains: 'cisco', mode: 'insensitive' },
    });
    expect(
      getWhere(
        toPrisma({
          field: 'name',
          operator: Operator.equals,
          value: 'cisco',
          caseInsensitive: true,
        }),
      ),
    ).toEqual({
      name: { equals: 'cisco', mode: 'insensitive' },
    });
    expect(
      getWhere(
        toPrisma({
          field: 'name',
          operator: Operator.notContains,
          value: 'cisco',
          caseInsensitive: true,
        }),
      ),
    ).toEqual({ name: { not: { contains: 'cisco', mode: 'insensitive' } } });
  });

  test('default omits mode', () => {
    expect(
      getWhere(toPrisma({ field: 'name', operator: Operator.contains, value: 'cisco' })),
    ).toEqual({
      name: { contains: 'cisco' },
    });
  });
});

describe('caseInsensitive flag — toSql', () => {
  test('caseInsensitive:true wraps both sides in LOWER()', () => {
    expect(
      toSql({ field: 'name', operator: Operator.contains, value: 'cisco', caseInsensitive: true })
        .sql,
    ).toContain('LOWER(');
    expect(
      toSql({ field: 'name', operator: Operator.equals, value: 'cisco', caseInsensitive: true })
        .sql,
    ).toContain('LOWER(');
  });

  test('default does not wrap in LOWER()', () => {
    expect(toSql({ field: 'name', operator: Operator.contains, value: 'cisco' }).sql).not.toContain(
      'LOWER(',
    );
  });
});
