import { describe, expect, test } from 'bun:test';
import { validateNarrowing } from '../src/lens/narrowing';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
        account: { kind: 'object', type: 'Account' },
      },
    },
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        active: { kind: 'scalar', type: 'Boolean' },
      },
    },
  },
};

const base: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };
const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({
  parent,
  ...rest,
});

const activeAccount: Condition = {
  all: [{ field: 'account.active', operator: Operator.equals, value: true }],
};

describe('sources — per-field eligibility wheres in the narrowing', () => {
  test('a source where surfaces per-field in the projected visit', () => {
    const n = withParent(base, { root: { sources: { tier: activeAccount } } });
    const root = projectByPath(n).get('User');
    expect(root?.sources.tier).toEqual([activeAccount]);
  });

  test('general (mapDefaults) + path-specific (root) compose for the same field', () => {
    const floor: Condition = { all: [{ field: 'id', operator: Operator.notEquals, value: '' }] };
    const n = withParent(base, {
      mapDefaults: { app: { models: { User: { sources: { tier: floor } } } } },
      root: { sources: { tier: activeAccount } },
    });
    expect(projectByPath(n).get('User')?.sources.tier).toEqual([floor, activeAccount]);
  });

  test('validateNarrowing rejects a source on an unknown field', () => {
    const n = withParent(base, { root: { sources: { nope: activeAccount } } });
    expect(() => validateNarrowing(n)).toThrow(/nope/);
  });

  test('validateNarrowing accepts a source whose where traverses a relation', () => {
    const n = withParent(base, { root: { sources: { tier: activeAccount } } });
    expect(() => validateNarrowing(n)).not.toThrow();
  });
});

describe('sources — SourceSpec { where, label }', () => {
  test('a SourceSpec surfaces its where in sources and its label in sourceLabels', () => {
    const n = withParent(base, {
      root: { sources: { tier: { where: activeAccount, label: 'id' } } },
    });
    const root = projectByPath(n).get('User');
    expect(root?.sources.tier).toEqual([activeAccount]);
    expect(root?.sourceLabels.tier).toBe('id');
  });

  test('a SourceSpec with only a label (no where) still surfaces the field with empty clauses', () => {
    const n = withParent(base, { root: { sources: { tier: { label: 'id' } } } });
    const root = projectByPath(n).get('User');
    expect(root?.sources.tier).toEqual([]);
    expect(root?.sourceLabels.tier).toBe('id');
  });

  test('a bare condition leaves sourceLabels empty for that field', () => {
    const n = withParent(base, { root: { sources: { tier: activeAccount } } });
    const root = projectByPath(n).get('User');
    expect(root?.sourceLabels.tier).toBeUndefined();
  });

  test('validateNarrowing accepts a SourceSpec { where, label }', () => {
    const n = withParent(base, {
      root: { sources: { tier: { where: activeAccount, label: 'id' } } },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });

  test('validateNarrowing rejects a SourceSpec whose label column is not on the model', () => {
    const n = withParent(base, {
      root: { sources: { tier: { where: activeAccount, label: 'nope' } } },
    });
    expect(() => validateNarrowing(n)).toThrow(/nope/);
  });
});
