import { describe, expect, test } from 'bun:test';
import { ConditionShape, getConditionShapeKeys } from '../index';
import { conditionShape } from '../src/traverse';

describe('getConditionShapeKeys', () => {
  test.each(
    Object.values(ConditionShape),
  )('a node with only the required keys of %s is that shape', (shape) => {
    const { required } = getConditionShapeKeys(shape);
    const node = Object.fromEntries(required.map((key) => [key, true]));
    expect(conditionShape(node)).toBe(shape);
  });

  test('returns a copy', () => {
    getConditionShapeKeys('all').required.push('any');
    expect(getConditionShapeKeys('all').required).toEqual(['all']);
  });
});
