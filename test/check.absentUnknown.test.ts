import { describe, expect, test } from 'bun:test';
import { check, Operator } from '../index';

const unknown = { absent: 'unknown' } as const;
const passes = (rule: Parameters<typeof check>[0], row: Record<string, unknown>) =>
  check(rule, row, unknown) === true;

describe("absent: 'unknown' — a value the row doesn't carry is not null", () => {
  test('a missing field fails equals', () => {
    expect(passes({ field: 'role', operator: Operator.equals, value: 'owner' }, {})).toBe(false);
  });

  test('a missing field fails equals null: null === null, undefined is not null', () => {
    expect(passes({ field: 'role', operator: Operator.equals, value: null }, {})).toBe(false);
  });

  test('a stored null still equals null', () => {
    expect(passes({ field: 'role', operator: Operator.equals, value: null }, { role: null })).toBe(
      true,
    );
  });

  test('a missing field fails in, even when the list holds null', () => {
    expect(passes({ field: 'role', operator: Operator.in, value: ['member', null] }, {})).toBe(
      false,
    );
  });

  test('a missing compared value fails equals against a null field', () => {
    expect(
      passes({ field: 'userId', operator: Operator.equals, path: 'actor.id' }, { userId: null }),
    ).toBe(false);
  });

  test('isEmpty and the negated operators keep their meaning on a missing field', () => {
    expect(passes({ field: 'role', operator: Operator.isEmpty, value: true }, {})).toBe(true);
    expect(passes({ field: 'role', operator: Operator.notEquals, value: 'owner' }, {})).toBe(true);
  });

  test('the default reads a missing field as null, as the compiled rails read a column', () => {
    expect(check({ field: 'role', operator: Operator.equals, value: null }, {})).toBe(true);
  });
});
