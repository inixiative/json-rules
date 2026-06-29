import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import { lensRequiredBindings, resolveLensBindings } from '../src/lens/bindings';
import { validateNarrowing } from '../src/lens/narrowing';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        brandUuid: { kind: 'scalar', type: 'String' },
        region: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' };
const rule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };

const brandBind: Condition = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
const regionBind: Condition = { field: 'region', operator: Operator.equals, bind: 'region' };

describe('resolveLensBindings — preprocess binds into the lens', () => {
  test('a bare lens carries no binds and is returned as-is', () => {
    expect(resolveLensBindings(lens, { brandUuid: 'acme-1' })).toBe(lens);
    expect(lensRequiredBindings(lens)).toEqual(new Set());
  });

  test('resolves a root.where bind, then applyLens is fully concrete', () => {
    const n: LensNarrowing = { parent: lens, root: { where: brandBind } };
    expect(lensRequiredBindings(n)).toEqual(new Set(['brandUuid']));

    const resolved = resolveLensBindings(n, { brandUuid: 'acme-1' });
    expect(lensRequiredBindings(resolved)).toEqual(new Set());
    expect(applyLens(rule, resolved)).toEqual({
      all: [{ field: 'brandUuid', operator: Operator.equals, value: 'acme-1' }, rule],
    });
  });

  test('partial — covers what the map has, leaves the rest as tokens', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = { parent: a, root: { where: regionBind } };
    expect(lensRequiredBindings(b)).toEqual(new Set(['brandUuid', 'region']));

    const partial = resolveLensBindings(b, { brandUuid: 'acme-1' });
    expect(lensRequiredBindings(partial)).toEqual(new Set(['region']));
    expect(applyLens(rule, partial)).toEqual({
      all: [{ field: 'brandUuid', operator: Operator.equals, value: 'acme-1' }, regionBind, rule],
    });
  });

  test('resolves binds in a source eligibility where (sourceQueries/projection see concrete)', () => {
    const n: LensNarrowing = { parent: lens, root: { sources: { tier: brandBind } } };
    const resolved = resolveLensBindings(n, { brandUuid: 'acme-1' });
    expect(projectByPath(resolved).get('FanUser')?.sources.tier).toEqual([
      { field: 'brandUuid', operator: Operator.equals, value: 'acme-1' },
    ]);
  });

  test('does not mutate the input lens', () => {
    const n: LensNarrowing = { parent: lens, root: { where: brandBind } };
    resolveLensBindings(n, { brandUuid: 'acme-1' });
    expect(n.root?.where).toEqual(brandBind);
  });
});

describe('bind-name discipline — unique names + parent:', () => {
  test('a child re-declaring an ancestor bind name is rejected', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = {
      parent: a,
      root: { where: { field: 'region', operator: Operator.equals, bind: 'brandUuid' } },
    };
    expect(() => validateNarrowing(b)).toThrow(/already declared by an ancestor/);
  });

  test('parent:name references an inherited binding read-only — no collision, draws the same value', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = {
      parent: a,
      root: { where: { field: 'region', operator: Operator.equals, bind: 'parent:brandUuid' } },
    };
    expect(() => validateNarrowing(b)).not.toThrow();
    expect(lensRequiredBindings(b)).toEqual(new Set(['brandUuid']));

    const resolved = resolveLensBindings(b, { brandUuid: 'acme-1' });
    expect(applyLens(rule, resolved)).toEqual({
      all: [
        { field: 'brandUuid', operator: Operator.equals, value: 'acme-1' },
        { field: 'region', operator: Operator.equals, value: 'acme-1' },
        rule,
      ],
    });
  });

  test('a parent: reference no ancestor declares is rejected', () => {
    const b: LensNarrowing = {
      parent: lens,
      root: { where: { field: 'region', operator: Operator.equals, bind: 'parent:brandUuid' } },
    };
    expect(() => validateNarrowing(b)).toThrow(/no ancestor declares/);
  });
});
