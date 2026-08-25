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

const EMPTY = { values: [], binds: [], paths: [] };

describe('referencedFieldValues', () => {
  test('collects a relation-nested value, whatever the quantifier', () => {
    expect(referencedFieldValues(membershipRule('any', 'g1'), MEMBERSHIP).values).toEqual(['g1']);
    expect(referencedFieldValues(membershipRule('none', 'g2'), MEMBERSHIP).values).toEqual(['g2']);
  });

  test('flattens list operators and dedups repeats', () => {
    const rule: Condition = {
      any: [
        {
          field: 'fanUserGroups',
          arrayOperator: ArrayOperator.none,
          condition: { field: 'group.uuid', operator: Operator.in, value: ['a', 'b', 'c'] },
        },
        membershipRule('any', 'b'),
      ],
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(['a', 'b', 'c']);
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
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(['a', 'b', 'c', 'd']);
  });

  test('collects a value carried by a windowing filter', () => {
    const rule: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'createdAt', dir: 'desc' }],
      take: 1,
      filter: { field: 'group.uuid', operator: Operator.equals, value: 'windowed' },
      condition: { field: 'group.uuid', operator: Operator.equals, value: 'inner' },
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(['inner', 'windowed']);
  });

  test('collects the dotted spelling of the same path', () => {
    const rule: Condition = { field: MEMBERSHIP, operator: Operator.equals, value: 'dotted' };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(['dotted']);
  });

  test('a same-named leaf under a different relation is not collected', () => {
    const rule: Condition = {
      field: 'submissions',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'group.uuid', operator: Operator.equals, value: 'not-a-membership' },
    };
    expect(referencedFieldValues(rule, MEMBERSHIP)).toEqual(EMPTY);
  });

  test('an aggregate over the relation descends, but its own value is not a relation value', () => {
    const rule: Condition = {
      field: 'fanUserGroups',
      aggregate: { mode: 'sum', field: 'points' },
      operator: Operator.greaterThan,
      value: 100,
      condition: { field: 'group.uuid', operator: Operator.equals, value: 'g9' },
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(['g9']);
  });

  test('an unnamed root array is walked through rather than treated as a relation', () => {
    const rule: Condition = {
      arrayOperator: ArrayOperator.any,
      condition: membershipRule('any', 'through'),
    };
    expect(referencedFieldValues(rule, MEMBERSHIP).values).toEqual(['through']);
  });

  test('path- and bind-sourced comparisons are reported by name, not flattened into values', () => {
    const rule: Condition = {
      all: [
        {
          field: 'fanUserGroups',
          arrayOperator: ArrayOperator.none,
          condition: { field: 'group.uuid', operator: Operator.equals, path: '$.currentGroupUuid' },
        },
        {
          field: 'fanUserGroups',
          arrayOperator: ArrayOperator.none,
          condition: { field: 'group.uuid', operator: Operator.equals, bind: 'groupUuid' },
        },
        membershipRule('any', 'literal'),
      ],
    };
    expect(referencedFieldValues(rule, MEMBERSHIP)).toEqual({
      values: ['literal'],
      binds: ['groupUuid'],
      paths: ['$.currentGroupUuid'],
    });
  });

  test('a bind resolved via resolveBindings is a literal like any other', () => {
    const rule: Condition = {
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.none,
      condition: { field: 'group.uuid', operator: Operator.equals, bind: 'groupUuid' },
    };
    const before = referencedFieldValues(rule, MEMBERSHIP);
    expect(before).toEqual({ values: [], binds: ['groupUuid'], paths: [] });
  });

  test('no match is empty everywhere', () => {
    const rule: Condition = { field: 'email', operator: Operator.equals, value: 'a@b.c' };
    expect(referencedFieldValues(rule, MEMBERSHIP)).toEqual(EMPTY);
  });

  test('a bare boolean condition is inert', () => {
    expect(referencedFieldValues(true, MEMBERSHIP)).toEqual(EMPTY);
  });

  test('the result is plain JSON — it survives a serialization round-trip', () => {
    const refs = referencedFieldValues(membershipRule('any', 'g1'), MEMBERSHIP);
    expect(JSON.parse(JSON.stringify(refs))).toEqual(refs);
  });
});

describe('transformFieldValues', () => {
  const remap = { old: 'new' };

  test('rewrites a relation-nested value and leaves the shape intact', () => {
    const out = transformFieldValues(membershipRule('none', 'old'), MEMBERSHIP, remap);
    expect(out).toEqual(membershipRule('none', 'new'));
  });

  test('rewrites each entry of a list operator, leaving unmapped entries alone', () => {
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

  test('remaps numeric literals through their string key', () => {
    const rule = (value: RuleValue): Condition => ({
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'group.uuid', operator: Operator.equals, value },
    });
    expect(transformFieldValues(rule(41), MEMBERSHIP, { '41': 42 })).toEqual(rule(42));
  });

  test('null and boolean literals never remap — only strings and numbers carry ids', () => {
    const rule = (value: RuleValue): Condition => ({
      field: 'fanUserGroups',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'group.uuid', operator: Operator.equals, value },
    });
    expect(transformFieldValues(rule(null), MEMBERSHIP, { null: 'trap' })).toEqual(rule(null));
    expect(transformFieldValues(rule(true), MEMBERSHIP, { true: 'trap' })).toEqual(rule(true));
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
    expect(referencedFieldValues(out, MEMBERSHIP).values).toEqual(['new', 'keep']);
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
