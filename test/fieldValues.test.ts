import { describe, expect, test } from 'bun:test';
import {
  ArrayOperator,
  type Condition,
  Operator,
  type RuleValue,
  referencedFieldValues,
  requiredBindings,
  transformFieldValues,
} from '../index';

const MEMBERSHIP = 'fanUserGroups.group.uuid';

const membershipRule = (arrayOperator: 'any' | 'none', value: RuleValue): Condition => ({
  field: 'fanUserGroups',
  arrayOperator: ArrayOperator[arrayOperator],
  condition: { field: 'group.uuid', operator: Operator.equals, value },
});

describe('referencedFieldValues', () => {
  test('collects a relation-nested value, whatever the quantifier', () => {
    expect(referencedFieldValues(membershipRule('any', 'g1'), MEMBERSHIP).values).toEqual(
      new Set(['g1']),
    );
    expect(referencedFieldValues(membershipRule('none', 'g2'), MEMBERSHIP).values).toEqual(
      new Set(['g2']),
    );
  });

  test('flattens list operators', () => {
    const rule: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.none,
      condition: { field: 'group.uuid', operator: Operator.in, value: ['a', 'b', 'c'] },
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(new Set(['a', 'b', 'c']));
  });

  test('collects across nested all/any and if/then/else arms', () => {
    const rule: Condition = {
      all: [
        membershipRule('none', 'a'),
        {
          any: [
            membershipRule('any', 'b'),
            { if: membershipRule('any', 'c'), then: membershipRule('none', 'd') },
          ],
        },
      ],
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  test('collects a value carried by a windowing filter', () => {
    // The blind spot every hand-rolled walker shared: `filter` is a condition, so a
    // reference can live there and never appear in `condition`.
    const rule: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'createdAt', dir: 'desc' }],
      take: 1,
      filter: { field: 'group.uuid', operator: Operator.equals, value: 'windowed' },
      condition: { field: 'group.uuid', operator: Operator.equals, value: 'inner' },
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(new Set(['windowed', 'inner']));
  });

  test('collects the dotted spelling of the same path', () => {
    const rule: Condition = { field: MEMBERSHIP, operator: Operator.equals, value: 'dotted' };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(new Set(['dotted']));
  });

  test('a same-named leaf under a different relation is not collected', () => {
    const rule: Condition = {
      field: 'submissions',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'group.uuid', operator: Operator.equals, value: 'not-a-membership' },
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(new Set());
  });

  test('an aggregate over the relation descends, but its own value is not a relation value', () => {
    const rule: Condition = {
      field: 'fanUserGroups',
      aggregate: { mode: 'sum', field: 'points' },
      operator: Operator.greaterThan,
      value: 100,
      condition: { field: 'group.uuid', operator: Operator.equals, value: 'g9' },
    };
    const refs = referencedFieldValues(rule, MEMBERSHIP);
    expect(refs.values).toEqual(new Set(['g9']));
    expect(refs.values.has(100)).toBe(false);
  });

  test('an unnamed root array is walked through rather than treated as a relation', () => {
    const rule: Condition = {
      arrayOperator: ArrayOperator.any,
      condition: membershipRule('any', 'through'),
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(new Set(['through']));
  });

  test('path- and bind-sourced comparisons report dynamic instead of vanishing', () => {
    const viaPath: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.none,
      condition: { field: 'group.uuid', operator: Operator.equals, path: '$.currentGroupUuid' },
    };
    expect(referencedFieldValues(viaPath, MEMBERSHIP)).toEqual({
      values: new Set(),
      dynamic: true,
    });

    const viaBind: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.none,
      condition: { field: 'group.uuid', operator: Operator.equals, bind: 'groupUuid' },
    };
    expect(referencedFieldValues(viaBind, MEMBERSHIP)).toEqual({
      values: new Set(),
      dynamic: true,
    });
  });

  test('no match is an empty set, not dynamic', () => {
    const rule: Condition = { field: 'email', operator: Operator.equals, value: 'a@b.c' };
    expect(referencedFieldValues(rule, MEMBERSHIP)).toEqual({ values: new Set(), dynamic: false });
  });

  test('a bare boolean condition is inert', () => {
    expect(referencedFieldValues(true, MEMBERSHIP)).toEqual({ values: new Set(), dynamic: false });
  });
});

describe('transformFieldValues', () => {
  const remap = (value: RuleValue): RuleValue => (value === 'old' ? 'new' : value);

  test('rewrites a relation-nested value and leaves the shape intact', () => {
    const out = transformFieldValues(membershipRule('none', 'old'), MEMBERSHIP, remap);
    expect(out).toEqual(membershipRule('none', 'new'));
  });

  test('rewrites each entry of a list operator', () => {
    const rule = (value: RuleValue): Condition => ({
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.none,
      condition: { field: 'group.uuid', operator: Operator.in, value },
    });
    expect(transformFieldValues(rule(['old', 'keep']), MEMBERSHIP, remap)).toEqual(
      rule(['new', 'keep']),
    );
  });

  test('rewrites inside a windowing filter', () => {
    const rule = (value: RuleValue): Condition => ({
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.any,
      filter: { field: 'group.uuid', operator: Operator.equals, value },
    });
    expect(transformFieldValues(rule('old'), MEMBERSHIP, remap)).toEqual(rule('new'));
  });

  test('leaves other fields, other relations and path/bind leaves alone', () => {
    const rule: Condition = {
      all: [
        { field: 'email', operator: Operator.equals, value: 'old' },
        {
          field: 'submissions',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'group.uuid', operator: Operator.equals, value: 'old' },
        },
        {
          field: 'fanUserGroups',
          arrayOperator: ArrayOperator.none,
          condition: { field: 'group.uuid', operator: Operator.equals, bind: 'old' },
        },
      ],
    };
    expect(transformFieldValues(rule, MEMBERSHIP, remap)).toEqual(rule);
  });

  test('does not mutate the input', () => {
    const rule = membershipRule('none', 'old');
    const snapshot = structuredClone(rule);
    transformFieldValues(rule, MEMBERSHIP, remap);
    expect(rule).toEqual(snapshot);
  });

  test('round-trips with referencedFieldValues', () => {
    const rule: Condition = {
      all: [membershipRule('none', 'old'), membershipRule('any', 'keep')],
    };
    const out = transformFieldValues(rule, MEMBERSHIP, remap);
    expect(referencedFieldValues(out, MEMBERSHIP).values).toEqual(new Set(['new', 'keep']));
  });
});

describe('requiredBindings walks windowing filters', () => {
  test('a bind inside a filter is required', () => {
    const rule: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.any,
      filter: { field: 'group.uuid', operator: Operator.equals, bind: 'groupUuid' },
      condition: { field: 'joinedAt', operator: Operator.greaterThan, bind: 'since' },
    };
    expect(requiredBindings(rule)).toEqual(new Set(['groupUuid', 'since']));
  });
});
