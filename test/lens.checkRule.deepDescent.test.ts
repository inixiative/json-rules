import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { createLens } from '../src/lens/createLens';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  User: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      posts: { kind: 'object', type: 'Post', isList: true },
    },
  },
  Post: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      title: { kind: 'scalar', type: 'String' },
      comments: { kind: 'object', type: 'Comment', isList: true },
    },
  },
  Comment: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      body: { kind: 'scalar', type: 'String' },
      score: { kind: 'scalar', type: 'Int' },
    },
  },
};

const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });

describe('checkRuleAgainstLens — deep descent into nested relations', () => {
  test('arrayRule → arrayRule (relation within relation) resolves at each anchor', () => {
    // Rule: user.posts.any(comments.any(body equals X))
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'body', operator: Operator.equals, value: 'hi' },
      },
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('arrayRule → arrayRule with bogus inner-leaf field is caught', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'ghostField', operator: Operator.equals, value: 'x' },
      },
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('ghostField');
  });

  test('aggregate → relation field reference resolves at relation target', () => {
    const rule = {
      field: 'posts',
      aggregate: { mode: 'sum' as const, field: 'comments' },
      condition: { field: 'title', operator: Operator.equals, value: 'X' },
      operator: Operator.greaterThan,
      value: 5,
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(true);
  });

  test('aggregate condition with bogus relation field caught', () => {
    const rule = {
      field: 'posts',
      aggregate: { mode: 'sum' as const, field: 'comments' },
      condition: { field: 'ghostField', operator: Operator.equals, value: 'x' },
      operator: Operator.greaterThan,
      value: 5,
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('ghostField');
  });

  test('if/then/else with relation-aware children — anchor preserved across branches', () => {
    const rule = {
      if: { field: 'email', operator: Operator.equals, value: 'a@b.com' },
      then: {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'title', operator: Operator.equals, value: 'admin' },
      },
      else: {
        field: 'posts',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'body', operator: Operator.equals, value: 'public' },
      },
    };
    // 'body' is on Comment, not Post → should fail the `else` branch
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('body');
  });

  test('three-deep arrayRule chain (posts.any → comments.any → body)', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        all: [
          { field: 'title', operator: Operator.equals, value: 'X' },
          {
            field: 'comments',
            arrayOperator: ArrayOperator.atLeast,
            count: 1,
            condition: { field: 'score', operator: Operator.greaterThan, value: 5 },
          },
        ],
      },
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(true);
  });

  test('three-deep with bogus inner-inner field is caught at the third level', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.atLeast,
        count: 1,
        condition: { field: 'nope', operator: Operator.equals, value: 'x' },
      },
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('nope');
  });
});
