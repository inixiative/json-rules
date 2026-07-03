import { describe, expect, test } from 'bun:test';
import type { LensNarrowing } from '../index';
import { createLens, sourceValuesFromRows } from '../index';

const lens = createLens({
  mapName: 'sdk',
  model: 'Reward',
  maps: {
    sdk: {
      models: {
        Reward: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            rewardType: { kind: 'scalar', type: 'String' },
            regionId: { kind: 'scalar', type: 'String' },
            regionName: { kind: 'scalar', type: 'String' },
            isActive: { kind: 'scalar', type: 'Boolean' },
            priority: { kind: 'scalar', type: 'Int' },
            tags: { kind: 'scalar', type: 'String', isList: true },
            brand: { kind: 'object', type: 'Brand' },
          },
        },
        Brand: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            tier: { kind: 'scalar', type: 'String' },
          },
        },
      },
    },
  },
});

const rows = [
  {
    id: '1',
    rewardType: 'physical',
    regionId: 'us',
    regionName: 'United States',
    isActive: true,
    priority: 2,
    tags: ['featured', 'new'],
    brand: { id: 'b1', tier: 'gold' },
  },
  {
    id: '2',
    rewardType: 'digital',
    regionId: 'eu',
    regionName: 'Europe',
    isActive: true,
    priority: 10,
    tags: ['featured'],
    brand: { id: 'b2', tier: 'silver' },
  },
  {
    id: '3',
    rewardType: 'physical',
    regionId: 'us',
    regionName: 'United States',
    isActive: false,
    priority: 1,
    tags: [],
    brand: { id: 'b3', tier: 'gold' },
  },
  {
    id: '4',
    rewardType: null,
    regionId: 'apac',
    regionName: 'Asia Pacific',
    isActive: true,
    priority: 3,
    tags: ['clearance'],
    brand: { id: 'b4', tier: 'bronze' },
  },
];

describe('sourceValuesFromRows', () => {
  test('materializes distinct sorted options for a root sourced field, skipping nulls', () => {
    const narrowing: LensNarrowing = { parent: lens, root: { sources: { rewardType: true } } };
    const [sv] = sourceValuesFromRows(narrowing, rows);
    expect(sv).toEqual({
      path: 'Reward',
      mapName: 'sdk',
      model: 'Reward',
      field: 'rewardType',
      options: [{ value: 'digital' }, { value: 'physical' }],
    });
  });

  test('co-selects a sibling label column from a SourceSpec', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { sources: { regionId: { label: 'regionName' } } },
    };
    const [sv] = sourceValuesFromRows(narrowing, rows);
    expect(sv.options).toEqual([
      { value: 'apac', label: 'Asia Pacific' },
      { value: 'eu', label: 'Europe' },
      { value: 'us', label: 'United States' },
    ]);
  });

  test('applies the source eligibility where over the rows', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      root: {
        sources: { rewardType: { where: { field: 'isActive', operator: 'equals', value: true } } },
      },
    };
    const [sv] = sourceValuesFromRows(narrowing, rows);
    expect(sv.options).toEqual([{ value: 'digital' }, { value: 'physical' }]);
  });

  test("ignores the visit's data-narrowing where — rows are lens-scoped by contract", () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      root: {
        where: { field: 'isActive', operator: 'equals', value: false },
        sources: { rewardType: true },
      },
    };
    const [sv] = sourceValuesFromRows(narrowing, rows);
    expect(sv.options).toEqual([{ value: 'digital' }, { value: 'physical' }]);
  });

  test('resolves a bind-parameterized eligibility where via CheckOptions', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      root: {
        sources: {
          rewardType: { where: { field: 'regionId', operator: 'equals', bind: 'region' } },
        },
      },
    };
    const [sv] = sourceValuesFromRows(narrowing, rows, { bindings: { region: 'us' } });
    expect(sv.options).toEqual([{ value: 'physical' }]);
  });

  test('flattens scalar-list sourced fields to one option per element', () => {
    const narrowing: LensNarrowing = { parent: lens, root: { sources: { tags: true } } };
    const [sv] = sourceValuesFromRows(narrowing, rows);
    expect(sv.options).toEqual([{ value: 'clearance' }, { value: 'featured' }, { value: 'new' }]);
  });

  test('sorts numeric values numerically in a fixed locale', () => {
    const narrowing: LensNarrowing = { parent: lens, root: { sources: { priority: true } } };
    const [sv] = sourceValuesFromRows(narrowing, rows);
    expect(sv.options.map((o) => o.value)).toEqual(['1', '2', '3', '10']);
  });

  test('prefers the first non-null label when rows disagree', () => {
    const sparseRows = [
      { regionId: 'us', regionName: null },
      { regionId: 'us', regionName: 'United States' },
    ];
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { sources: { regionId: { label: 'regionName' } } },
    };
    const [sv] = sourceValuesFromRows(narrowing, sparseRows);
    expect(sv.options).toEqual([{ value: 'us', label: 'United States' }]);
  });

  test('materializes sourced fields on relation-traversed paths', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { relations: { brand: { sources: { tier: true } } } },
    };
    const values = sourceValuesFromRows(narrowing, rows);
    const brandTier = values.find((sv) => sv.path === 'Reward.brand');
    expect(brandTier).toEqual({
      path: 'Reward.brand',
      mapName: 'sdk',
      model: 'Brand',
      field: 'tier',
      options: [{ value: 'bronze' }, { value: 'gold' }, { value: 'silver' }],
    });
  });

  test('returns nothing when no sources are declared', () => {
    expect(sourceValuesFromRows(lens, rows)).toEqual([]);
  });

  // Aliased relations: two differently-named relation fields targeting the SAME model.
  // Resolution goes through the entry's `type`, and each relation path is its own
  // projection visit — the materialized option sets stay separate per path.
  test('aliased self-relations (parents/children → User) materialize per path', () => {
    const people = createLens({
      mapName: 'app',
      model: 'User',
      maps: {
        app: {
          models: {
            User: {
              fields: {
                name: { kind: 'scalar', type: 'String' },
                team: { kind: 'scalar', type: 'String' },
                parents: { kind: 'object', type: 'User', isList: true },
                children: { kind: 'object', type: 'User', isList: true },
              },
            },
          },
        },
      },
    });
    const narrowing: LensNarrowing = {
      parent: people,
      root: {
        relations: {
          parents: { sources: { team: true } },
          children: { sources: { team: true } },
        },
      },
    };
    const users = [
      {
        name: 'root',
        team: 'core',
        parents: [{ name: 'p1', team: 'legal' }],
        children: [
          { name: 'c1', team: 'design' },
          { name: 'c2', team: 'sales' },
        ],
      },
    ];
    const values = sourceValuesFromRows(narrowing, users);
    const parents = values.find((sv) => sv.path === 'User.parents');
    const children = values.find((sv) => sv.path === 'User.children');
    expect(parents?.model).toBe('User');
    expect(children?.model).toBe('User');
    expect(parents?.options).toEqual([{ value: 'legal' }]);
    expect(children?.options).toEqual([{ value: 'design' }, { value: 'sales' }]);
  });
});

describe('sources entry hygiene: {} is not a Condition', () => {
  test('an empty-object sources entry throws instead of silently matching nothing', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      // @ts-expect-error — {} is neither a Condition nor a SourceSpec (both keys absent)
      root: { sources: { rewardType: {} } },
    };
    expect(() => sourceValuesFromRows(narrowing, rows)).toThrow('sources: {} is not a Condition');
  });

  test('the unconstrained spelling is `true`', () => {
    const narrowing: LensNarrowing = { parent: lens, root: { sources: { rewardType: true } } };
    const [values] = sourceValuesFromRows(narrowing, rows);
    expect(values.options.length).toBeGreaterThan(0);
  });

  test('a label-only SourceSpec still registers the field unconstrained', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { sources: { regionId: { label: 'regionName' } } },
    };
    const [values] = sourceValuesFromRows(narrowing, rows);
    expect(values.options.length).toBeGreaterThan(0);
    expect(values.options[0].label).toBeDefined();
  });
});
