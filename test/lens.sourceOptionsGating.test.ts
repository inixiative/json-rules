import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { exposedSurface } from '../src/lens/exposedSurface';
import type { SourceValues } from '../src/lens/projectByPath';
import type { Lens } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// The hydrated-source gate: a consumer (e.g. rules-builder) folds fetched sourceValues
// onto `field.options` via exposedSurface, then re-feeds the exposed surface back into
// checkRuleAgainstLens. The fetched option set must gate the allowed values — otherwise a
// rule can reference a value outside the source's fetched set. `free` carries no input
// `values`, so the folded `options` is the ONLY gating source.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        free: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };

const sourceValues: SourceValues[] = [
  {
    path: 'User',
    mapName: 'app',
    model: 'User',
    field: 'free',
    options: [{ value: 'gold' }, { value: 'silver' }],
  },
];

describe('checkRuleAgainstLens — gates against folded source options', () => {
  test('a value in the folded option set passes', () => {
    const surface = exposedSurface(lens, { sourceValues });
    const result = checkRuleAgainstLens(
      { field: 'free', operator: Operator.equals, value: 'gold' },
      surface,
    );
    expect(result.ok).toBe(true);
  });

  test('a value NOT in the folded option set is rejected', () => {
    const surface = exposedSurface(lens, { sourceValues });
    const result = checkRuleAgainstLens(
      { field: 'free', operator: Operator.equals, value: 'platinum' },
      surface,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('free');
  });
});
