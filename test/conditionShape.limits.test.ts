import { describe, expect, test } from 'bun:test';
import type { Condition, Lens } from '../index';
import { check, narrowRule, toPrisma, toSql, validateRule, validateRuleInLens } from '../index';

// Every rail recurses through a condition, and an untrusted rule can be any depth or any mix of
// node kinds: deep ones are refused before they overflow the stack, ambiguous ones by the gate.

const nest = (depth: number): Condition => {
  let rule: Condition = { field: 'a', operator: 'equals', value: 1 };
  for (let i = 1; i < depth; i++) rule = { all: [rule] };
  return rule;
};
const lens: Lens = {
  maps: { app: { models: { T: { fields: { a: { kind: 'scalar', type: 'Int' } } } } } },
  mapName: 'app',
  model: 'T',
};

describe('nesting depth', () => {
  const deep = nest(20_000);
  test('every entry point refuses it', () => {
    for (const run of [
      () => check(deep, { a: 1 }),
      () => toSql(deep),
      () => toPrisma(deep),
      () => narrowRule(deep, lens),
      () => validateRuleInLens(deep, lens),
    ])
      expect(run).toThrow('nest at most 256');
    expect(validateRule(deep).errors[0].code).toBe('condition_too_deep');
  });

  test('256 levels evaluate', () => {
    expect(check(nest(256), { a: 1 })).toBe(true);
  });
});

describe('a node of two kinds', () => {
  test.each([
    { field: 'a', operator: 'equals', value: 1, dateOperator: 'before' },
    {
      field: 'a',
      arrayOperator: 'empty',
      aggregate: { mode: 'sum' },
      operator: 'equals',
      value: 1,
    },
    { all: [], field: 'a', operator: 'equals', value: 1 },
  ])('the gate refuses %o', (node) => {
    expect(validateRuleInLens(node as Condition, lens).errors[0].code).toBe('ambiguous_condition');
  });
});
