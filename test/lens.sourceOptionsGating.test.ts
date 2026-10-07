import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '../src/fieldMap/types';
import { projectModels } from '../src/lens/projectModels';
import type { SourceValues } from '../src/lens/projectPaths';
import type { Lens } from '../src/lens/types';
import { validateRuleInLens } from '../src/lens/validateRuleInLens';
import { Operator } from '../src/operator';

// The hydrated-source gate: a consumer (e.g. rules-builder) folds fetched sourceValues
// onto `field.options` via projectModels, then re-feeds the exposed surface back into
// validateRuleInLens. The fetched option set must gate the allowed values — otherwise a
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

describe('validateRuleInLens — gates against folded source options', () => {
  test('a value in the folded option set passes', () => {
    const surface = projectModels(lens, { sourceValues });
    const result = validateRuleInLens(
      { field: 'free', operator: Operator.equals, value: 'gold' },
      surface,
    );
    expect(result.ok).toBe(true);
  });

  test('a value NOT in the folded option set is rejected', () => {
    const surface = projectModels(lens, { sourceValues });
    const result = validateRuleInLens(
      { field: 'free', operator: Operator.equals, value: 'platinum' },
      surface,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('free');
  });
});
