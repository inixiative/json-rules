import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// A field's `values` should gate the allowed set regardless of `kind` — not just
// `kind:'enum'`. This is what hydrated sources rely on: the projection folds fetched
// `values` onto a scalar (or Json) field, and checkRuleAgainstLens must then reject
// rule values outside the fetched option set.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String', values: ['gold', 'silver', 'bronze'] },
        meta: { kind: 'scalar', type: 'Json', values: ['a', 'b'] },
        free: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('checkRuleAgainstLens — value gating on non-enum fields', () => {
  test('scalar field with values: value in set passes', () => {
    const result = checkRuleAgainstLens(
      { field: 'tier', operator: Operator.equals, value: 'gold' },
      lens,
    );
    expect(result.ok).toBe(true);
  });

  test('scalar field with values: value NOT in set is rejected', () => {
    const result = checkRuleAgainstLens(
      { field: 'tier', operator: Operator.equals, value: 'platinum' },
      lens,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('tier');
    expect(result.violations[0].reason).toMatch(/tier|platinum|allowed/i);
  });

  test('in operator: array value with one bad member is rejected', () => {
    const result = checkRuleAgainstLens(
      { field: 'tier', operator: Operator.in, value: ['gold', 'platinum'] },
      lens,
    );
    expect(result.ok).toBe(false);
  });

  test('Json-typed field with values is gated too', () => {
    expect(
      checkRuleAgainstLens({ field: 'meta', operator: Operator.equals, value: 'a' }, lens).ok,
    ).toBe(true);
    expect(
      checkRuleAgainstLens({ field: 'meta', operator: Operator.equals, value: 'z' }, lens).ok,
    ).toBe(false);
  });

  test('scalar field WITHOUT values is not gated (passes through)', () => {
    const result = checkRuleAgainstLens(
      { field: 'free', operator: Operator.equals, value: 'anything' },
      lens,
    );
    expect(result.ok).toBe(true);
  });

  test('enumOmits narrows a non-enum value set too', () => {
    const n = withParent(lens, { root: { enumOmits: { tier: ['bronze'] } } });
    expect(
      checkRuleAgainstLens({ field: 'tier', operator: Operator.equals, value: 'bronze' }, n).ok,
    ).toBe(false);
    expect(
      checkRuleAgainstLens({ field: 'tier', operator: Operator.equals, value: 'gold' }, n).ok,
    ).toBe(true);
  });
});
