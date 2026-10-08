import { describe, expect, test } from 'bun:test';
import { bindLens, getLensRoot, type Lens, type LensNarrowing } from '../index';

const base: Lens = {
  maps: { app: { models: { User: { fields: { orgId: { kind: 'scalar', type: 'String' } } } } } },
  mapName: 'app',
  model: 'User',
};
const org: LensNarrowing = {
  parent: base,
  root: { where: { field: 'orgId', operator: 'equals', bind: 'orgId' } },
};
const space: LensNarrowing = { parent: org, root: { picks: ['orgId'] } };

describe('getLensRoot', () => {
  test('a lens is its own root; a narrowing chain resolves to its base lens', () => {
    expect(getLensRoot(base)).toBe(base);
    expect(getLensRoot(org)).toBe(base);
    expect(getLensRoot(space)).toBe(base);
  });

  test('a cyclic chain throws', () => {
    const a = { parent: base } as LensNarrowing;
    const b: LensNarrowing = { parent: a };
    (a as { parent: Lens | LensNarrowing }).parent = b;
    expect(() => getLensRoot(b)).toThrow(/cycle detected/);
  });
});

describe('bindLens keeps the form it is given', () => {
  test('a narrowing comes back a narrowing, a lens the same lens — typed, no cast', () => {
    const bound: LensNarrowing = bindLens(space, { orgId: 'o1' });
    expect(bound.parent).not.toBe(org);
    expect((bound.parent as LensNarrowing).root?.where).toEqual({
      field: 'orgId',
      operator: 'equals',
      value: 'o1',
    });
    const same: Lens = bindLens(base, { orgId: 'o1' });
    expect(same).toBe(base);
  });
});
