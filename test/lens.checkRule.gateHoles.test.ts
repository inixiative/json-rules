import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

// FIX 3(a) — path (RHS) refs must be gated the same way as field (LHS) refs.
describe('checkRuleAgainstLens — path (RHS) refs are gated', () => {
  const map: FieldMap = {
    models: {
      Article: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          title: { kind: 'scalar', type: 'String' },
          secret: { kind: 'scalar', type: 'String' },
          author: { kind: 'object', type: 'User' },
        },
      },
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
          secret: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'Article' };

  test('non-$ path to an omitted related field → ok:false', () => {
    const n = withParent(lens, { root: { relations: { author: { omits: ['secret'] } } } });
    const rule: Condition = { field: 'title', operator: Operator.equals, path: 'author.secret' };
    const result = checkRuleAgainstLens(rule, n);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'author.secret')).toBe(true);
  });

  test('non-$ path to an IN-lens related field → ok:true (control)', () => {
    const rule: Condition = { field: 'title', operator: Operator.equals, path: 'author.name' };
    expect(checkRuleAgainstLens(rule, lens).ok).toBe(true);
  });

  test('non-$ path to a non-existent field → ok:false', () => {
    const rule: Condition = { field: 'title', operator: Operator.equals, path: 'author.ghost' };
    expect(checkRuleAgainstLens(rule, lens).ok).toBe(false);
  });

  test('$.-prefixed path to an omitted current-element field → ok:false', () => {
    const n = withParent(lens, { root: { omits: ['secret'] } });
    const rule: Condition = { field: 'title', operator: Operator.equals, path: '$.secret' };
    const result = checkRuleAgainstLens(rule, n);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === '$.secret')).toBe(true);
  });
});

// FIX 3(b) — a window's filter (a full Condition) and orderBy must be gated too.
describe('checkRuleAgainstLens — window filter/orderBy are gated', () => {
  const map: FieldMap = {
    models: {
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
          score: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };
  const omitScore = withParent(lens, { root: { relations: { posts: { omits: ['score'] } } } });

  test('window filter referencing an omitted element field → ok:false', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      filter: { field: 'score', operator: Operator.greaterThan, value: '5' },
      condition: { field: 'title', operator: Operator.equals, value: 'x' },
    } as unknown as Condition;
    const result = checkRuleAgainstLens(rule, omitScore);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'score')).toBe(true);
  });

  test('window filter referencing an in-lens element field → ok:true (control)', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      filter: { field: 'title', operator: Operator.equals, value: 'x' },
      condition: { field: 'title', operator: Operator.equals, value: 'x' },
    } as unknown as Condition;
    expect(checkRuleAgainstLens(rule, lens).ok).toBe(true);
  });

  test('orderBy on an omitted element field → ok:false', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'score', dir: 'asc' }],
      condition: { field: 'title', operator: Operator.equals, value: 'x' },
    } as unknown as Condition;
    const result = checkRuleAgainstLens(rule, omitScore);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'score')).toBe(true);
  });

  test('orderBy on an in-lens element field → ok:true (control)', () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'title', dir: 'asc' }],
      condition: { field: 'title', operator: Operator.equals, value: 'x' },
    } as unknown as Condition;
    expect(checkRuleAgainstLens(rule, lens).ok).toBe(true);
  });
});
