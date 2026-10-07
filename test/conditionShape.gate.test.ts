import { describe, expect, test } from 'bun:test';
import type { Condition, Lens } from '../index';
import { validateRuleInLens } from '../index';

// A node of two kinds would evaluate as one or the other depending on the rail: the gate refuses it.

const lens: Lens = {
  maps: { app: { models: { T: { fields: { a: { kind: 'scalar', type: 'Int' } } } } } },
  mapName: 'app',
  model: 'T',
};

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
