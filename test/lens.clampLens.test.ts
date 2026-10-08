import { describe, expect, test } from 'bun:test';
import type { FieldMapSet } from '../src/fieldMap/types';
import { clampLens } from '../src/lens/clampLens';
import { validateNarrowing } from '../src/lens/narrowing';
import { projectLens } from '../src/lens/projectLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { Condition } from '../src/types';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
          deletedAt: { kind: 'scalar', type: 'DateTime' },
          orgId: { kind: 'scalar', type: 'String' },
          org: {
            kind: 'object',
            type: 'Org',
            relationName: 'UserOrg',
            fromFields: ['orgId'],
            toFields: ['id'],
          },
        },
      },
      Org: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
          plan: { kind: 'scalar', type: 'String' },
        },
      },
    },
  },
};

const base: Lens = { maps, mapName: 'app', model: 'User' };
const live: Condition = { field: 'deletedAt', operator: Operator.notExists };
const named: Condition = { field: 'name', operator: Operator.notEmpty };
const paid: Condition = { field: 'plan', operator: Operator.equals, value: 'paid' };

const first: LensNarrowing = {
  parent: base,
  root: { where: named, relations: { org: {} } },
};
const viewer: LensNarrowing = { parent: first, root: { picks: ['id', 'name'] } };

describe('clampLens', () => {
  test('over a bare lens, it adds the first layer', () => {
    expect(clampLens(base, { root: { where: live } })).toEqual({
      parent: base,
      root: { where: live },
    });
  });

  test('a root where ANDs with the first layer’s own', () => {
    expect(clampLens(first, { root: { where: live } })).toEqual({
      parent: base,
      root: { where: { all: [named, live] }, relations: { org: {} } },
    });
  });

  test('later layers are kept as they are; the clamp lands under them', () => {
    const clamped = clampLens(viewer, { root: { where: live } });
    expect(clamped.root).toBe(viewer.root);
    expect((clamped.parent as LensNarrowing).root?.where).toEqual({ all: [named, live] });
    expect((clamped.parent as LensNarrowing).parent).toBe(base);
  });

  test('a clamp on a column a later layer hides is valid only in the first layer', () => {
    const reader: LensNarrowing = { parent: viewer, root: {} };
    expect(validateNarrowing({ ...reader, root: { where: live } }).ok).toBe(false);
    const clamped = clampLens(reader, { root: { where: live } });
    expect(validateNarrowing(clamped).ok).toBe(true);
    expect(projectLens(clamped).User?.whereClauses).toEqual([{ all: [named, live] }]);
    expect(Object.keys(projectLens(clamped).User?.fields ?? {})).toEqual(['id', 'name', 'org']);
  });

  test('model-default wheres AND per map and model', () => {
    const withDefaults: LensNarrowing = {
      ...first,
      mapDefaults: { app: { models: { Org: { where: named, picks: ['id', 'name'] } } } },
    };
    const clamped = clampLens(withDefaults, {
      mapDefaults: { app: { models: { Org: { where: paid }, User: { where: live } } } },
    });
    expect(clamped.mapDefaults).toEqual({
      app: {
        models: {
          Org: { where: { all: [named, paid] }, picks: ['id', 'name'] },
          User: { where: live },
        },
      },
    });
    expect(clamped.root).toBe(withDefaults.root);
  });

  test('source wheres AND, a bare Condition reads as its where, and label / groupBy win', () => {
    const withSources: LensNarrowing = {
      ...first,
      mapDefaults: {
        app: { models: { Org: { sources: { id: named, plan: { where: paid, label: 'name' } } } } },
      },
    };
    const clamped = clampLens(withSources, {
      mapDefaults: {
        app: {
          models: {
            Org: {
              sources: {
                id: { where: paid, label: 'name' },
                plan: live,
                name: { where: named, groupBy: 'plan' },
              },
            },
          },
        },
      },
    });
    expect(clamped.mapDefaults?.app?.models?.Org?.sources).toEqual({
      id: { where: { all: [named, paid] }, label: 'name' },
      plan: { where: { all: [paid, live] }, label: 'name' },
      name: { where: named, groupBy: 'plan' },
    });
  });

  test('no clamps leaves the first layer as it was', () => {
    expect(clampLens(viewer, {})).toEqual(viewer);
  });
});
