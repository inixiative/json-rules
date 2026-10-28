import { describe, expect, it } from 'bun:test';
import { ArrayOperator, Operator, toPrisma } from '../index';
import type { FieldMap } from '../src/fieldMap/types';

// A count of one or zero is presence. atLeast 1 compiles as `any` and atMost 0 / exactly 0 as
// `none`: a relation filter, with no groupBy step whose matching ids get inlined into the WHERE.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        posts: { kind: 'object', type: 'Post', isList: true, relationName: 'PostToUser' },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        authorId: { kind: 'scalar', type: 'String' },
        published: { kind: 'scalar', type: 'Boolean' },
        author: {
          kind: 'object',
          type: 'User',
          relationName: 'PostToUser',
          fromFields: ['authorId'],
          toFields: ['id'],
        },
      },
    },
  },
} as never;

const published = { field: 'published', operator: Operator.equals, value: true };
const posts = (arrayOperator: ArrayOperator, count?: number) => ({
  field: 'posts',
  arrayOperator,
  ...(count === undefined ? {} : { count }),
  condition: published,
});
const compile = (rule: unknown) => toPrisma(rule as never, { map, model: 'User' });
const groupBySteps = (rule: unknown) =>
  compile(rule).steps.filter((step) => step.operation === 'groupBy');

describe('toPrisma count presence', () => {
  it('compiles atLeast 1 exactly as any, with no groupBy step', () => {
    const counted = compile(posts(ArrayOperator.atLeast, 1));
    expect(counted).toEqual(compile(posts(ArrayOperator.any)));
    expect(groupBySteps(posts(ArrayOperator.atLeast, 1))).toEqual([]);
  });

  it('compiles atMost 0 and exactly 0 exactly as none, with no groupBy step', () => {
    const none = compile(posts(ArrayOperator.none));
    for (const op of [ArrayOperator.atMost, ArrayOperator.exactly]) {
      const counted = compile(posts(op, 0));
      expect(counted).toEqual(none);
      expect(groupBySteps(posts(op, 0))).toEqual([]);
    }
  });

  it('still counts with a groupBy step for anything else', () => {
    expect(groupBySteps(posts(ArrayOperator.atLeast, 2))).toHaveLength(1);
    expect(groupBySteps(posts(ArrayOperator.exactly, 1))).toHaveLength(1);
    expect(groupBySteps(posts(ArrayOperator.atMost, 1))).toHaveLength(1);
  });
});
