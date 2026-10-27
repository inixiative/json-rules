import { describe, expect, test } from 'bun:test';
import { Operator, prefixConditionFields } from '../index';

describe('prefixConditionFields is public: a condition re-rooted onto a related record', () => {
  test("a parent's condition reads the parent from the child", () => {
    expect(
      prefixConditionFields({ field: 'name', operator: Operator.equals, value: 'X' }, 'space'),
    ).toEqual({ field: 'space.name', operator: Operator.equals, value: 'X' });
  });

  test('a shape it cannot move is refused, not guessed', () => {
    expect(() =>
      prefixConditionFields({ field: 'name', operator: Operator.equals, path: 'other' }, 'space'),
    ).toThrow();
  });
});
