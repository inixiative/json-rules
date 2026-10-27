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

describe('prefixConditionFields with paths: the condition whose root becomes the child', () => {
  test('a plain record path moves with the field', () => {
    expect(
      prefixConditionFields(
        { field: 'provider', operator: Operator.equals, path: 'defaultProvider' },
        'space',
        { paths: true },
      ),
    ).toEqual({
      field: 'space.provider',
      operator: Operator.equals,
      path: 'space.defaultProvider',
    });
  });

  test('inside all / any, every leaf moves', () => {
    expect(
      prefixConditionFields(
        {
          all: [
            { field: 'name', operator: Operator.equals, value: 'X' },
            { field: 'provider', operator: Operator.equals, path: 'defaultProvider' },
          ],
        },
        'space',
        { paths: true },
      ),
    ).toEqual({
      all: [
        { field: 'space.name', operator: Operator.equals, value: 'X' },
        { field: 'space.provider', operator: Operator.equals, path: 'space.defaultProvider' },
      ],
    });
  });

  test('a scope ref is refused even with paths', () => {
    expect(() =>
      prefixConditionFields(
        { field: 'provider', operator: Operator.equals, path: '$.provider' },
        'space',
        { paths: true },
      ),
    ).toThrow();
  });
});
