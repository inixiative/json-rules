import { describe, expect, test } from 'bun:test';
import {
  exposedSurface,
  type Lens,
  type LensNarrowing,
  projectByPath,
  type SourceValues,
  sourceQueries,
  sourceValuesFromQueryRows,
  sourceValuesFromRows,
  validateNarrowing,
} from '../index';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// EAV shape: one physical `value` column whose vocabulary is partitioned by a
// related definition label — the case a flat DISTINCT source cannot serve.
const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
        enrichments: {
          kind: 'object',
          type: 'Enrichment',
          isList: true,
          fromFields: ['id'],
          toFields: ['userId'],
        },
      },
    },
    Enrichment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        userId: { kind: 'scalar', type: 'String' },
        value: { kind: 'scalar', type: 'String' },
        mapId: { kind: 'scalar', type: 'String' },
        map: {
          kind: 'object',
          type: 'IntegrationMap',
          fromFields: ['mapId'],
          toFields: ['id'],
        },
      },
    },
    IntegrationMap: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        brandId: { kind: 'scalar', type: 'String' },
        definitionId: { kind: 'scalar', type: 'String' },
        definition: {
          kind: 'object',
          type: 'FieldDef',
          fromFields: ['definitionId'],
          toFields: ['id'],
        },
      },
    },
    FieldDef: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        label: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const base: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };
const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

const grouped = (): LensNarrowing =>
  withParent(base, {
    root: {
      picks: ['id'],
      relations: {
        enrichments: {
          picks: ['value'],
          sources: {
            value: {
              where: { field: 'map.brandId', operator: Operator.equals, value: 'b1' },
              groupBy: 'map.definition.label',
            },
          },
        },
      },
    },
  });

describe('validateNarrowing — groupBy on a SourceSpec', () => {
  test('accepts a groupBy path through to-one relations ending on a scalar', () => {
    expect(() => validateNarrowing(grouped())).not.toThrow();
  });

  test('accepts a groupBy-only spec (no where, no label)', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });

  test('accepts a sibling-column groupBy (single segment)', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['value'], sources: { value: { groupBy: 'mapId' } } },
        },
      },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });

  test('rejects an unknown segment', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['value'], sources: { value: { groupBy: 'map.nope.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/groupBy/);
  });

  test('rejects a to-many hop', () => {
    const n = withParent(base, {
      root: { picks: ['tier'], sources: { tier: { groupBy: 'enrichments.value' } } },
    });
    expect(() => validateNarrowing(n)).toThrow(/groupBy/);
  });

  test('rejects a path ending on a relation', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['value'], sources: { value: { groupBy: 'map.definition' } } },
        },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/groupBy/);
  });
});

describe('projectByPath — groupBy exposure', () => {
  test('exposes sourceGroupBys per sourced field', () => {
    const visit = projectByPath(grouped()).get('User.enrichments');
    expect(visit?.sourceGroupBys).toEqual({ value: ['map.definition.label'] });
  });
});

describe('sourceQueries — grouped compile', () => {
  test('carries groupBy, drops distinct, nests the group path into the prisma select', () => {
    const [q] = sourceQueries(grouped());
    expect(q.groupBy).toEqual(['map.definition.label']);
    expect(q.prisma.distinct).toBeUndefined();
    expect(q.prisma.select).toEqual({
      value: true,
      map: { select: { definition: { select: { label: true } } } },
    });
  });

  test('selects the joined group column as "__group" in sql', () => {
    const [q] = sourceQueries(grouped());
    expect(q.sql.sql).toContain('SELECT DISTINCT');
    expect(q.sql.sql).toContain('AS "__group_0"');
    expect(q.sql.sql).toContain('LEFT JOIN "FieldDef"');
  });

  test('ungrouped sources keep the flat DISTINCT shape', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['value'], sources: { value: true } },
        },
      },
    });
    const [q] = sourceQueries(n);
    expect(q.groupBy).toBeUndefined();
    expect(q.prisma.distinct).toEqual(['value']);
    expect(q.prisma.select).toEqual({ value: true });
  });
});

describe('sourceValuesFromRows — grouped materialization', () => {
  test('partitions options by group and dedupes per (group, value)', () => {
    const rows = [
      {
        id: 'u1',
        enrichments: [
          { value: 'marketing', map: { brandId: 'b1', definition: { label: 'business unit' } } },
          { value: 'sales', map: { brandId: 'b1', definition: { label: 'business unit' } } },
          // same value under a second group must yield a second option
          { value: 'marketing', map: { brandId: 'b1', definition: { label: 'department' } } },
          { value: 'dup', map: { brandId: 'b1', definition: { label: 'department' } } },
          { value: 'dup', map: { brandId: 'b1', definition: { label: 'department' } } },
          // fails the source where → excluded entirely
          { value: 'foreign', map: { brandId: 'b2', definition: { label: 'business unit' } } },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(grouped(), rows);
    expect(sv.path).toBe('User.enrichments');
    expect(sv.field).toBe('value');
    expect(sv.options).toEqual([
      { value: 'marketing', groups: ['business unit'] },
      { value: 'sales', groups: ['business unit'] },
      { value: 'dup', groups: ['department'] },
      { value: 'marketing', groups: ['department'] },
    ]);
  });

  test('an eligible row whose group path is unreachable contributes an ungrouped option', () => {
    const n = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
    });
    const rows = [
      {
        id: 'u1',
        enrichments: [
          { value: 'grouped', map: { brandId: 'b1', definition: { label: 'business unit' } } },
          { value: 'orphan', map: null },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(n, rows);
    expect(sv.options).toEqual([
      { value: 'orphan' },
      { value: 'grouped', groups: ['business unit'] },
    ]);
  });
});

describe('grouped sources — traversed narrowing wheres fold into the compile', () => {
  // The groupBy traversal must honor the same guards as any lens traversal:
  // a relation node's `where` (tenancy/soft-delete) re-roots onto the anchor,
  // exactly like applyLens folds hop wheres for rules.
  const guarded = (): LensNarrowing =>
    withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
            relations: {
              map: {
                picks: [],
                where: { field: 'brandId', operator: Operator.equals, value: 'b1' },
              },
            },
          },
        },
      },
    });

  test('sourceQueries ANDs the hop where, re-rooted, into composedWhere', () => {
    const [q] = sourceQueries(guarded());
    expect(q.composedWhere).toEqual({
      field: 'map.brandId',
      operator: Operator.equals,
      value: 'b1',
    });
  });

  test('sourceValuesFromRows excludes rows whose traversed hop fails the guard', () => {
    const rows = [
      {
        id: 'u1',
        enrichments: [
          { value: 'kept', map: { brandId: 'b1', definition: { label: 'business unit' } } },
          { value: 'foreign', map: { brandId: 'b2', definition: { label: 'business unit' } } },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(guarded(), rows);
    expect(sv.options).toEqual([{ value: 'kept', groups: ['business unit'] }]);
  });
});

describe('sourceValuesFromQueryRows — materialize fetched query rows', () => {
  test('extracts the group from prisma-shaped nested rows, deduping per group', () => {
    const [q] = sourceQueries(grouped());
    const rows = [
      { value: 'marketing', map: { definition: { label: 'business unit' } } },
      { value: 'marketing', map: { definition: { label: 'business unit' } } },
      { value: 'sales', map: { definition: { label: 'department' } } },
    ];
    const sv = sourceValuesFromQueryRows(q, rows);
    expect(sv).toEqual({
      path: 'User.enrichments',
      mapName: 'app',
      model: 'Enrichment',
      field: 'value',
      options: [
        { value: 'marketing', groups: ['business unit'] },
        { value: 'sales', groups: ['department'] },
      ],
    });
  });

  test('sql row shape reads the "__group_0" alias explicitly', () => {
    const [q] = sourceQueries(grouped());
    const sv = sourceValuesFromQueryRows(q, [{ value: 'marketing', __group_0: 'business unit' }], {
      rowShape: 'sql',
    });
    expect(sv.options).toEqual([{ value: 'marketing', groups: ['business unit'] }]);
  });

  test('prisma row shape (the default) never reads a stray "__group" column', () => {
    const [q] = sourceQueries(grouped());
    // Null hop → ungrouped; a stray scalar column named __group must not mis-group it.
    const sv = sourceValuesFromQueryRows(q, [{ value: 'v', map: null, __groups: ['STRAY'] }]);
    expect(sv.options).toEqual([{ value: 'v' }]);
  });

  test('materializes ungrouped queries with a label sibling unchanged', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { where: true, label: 'mapId' } },
          },
        },
      },
    });
    const [q] = sourceQueries(n);
    const sv = sourceValuesFromQueryRows(q, [
      { value: 'b', mapId: 'Bee' },
      { value: 'a', mapId: 'Ay' },
    ]);
    expect(sv.options).toEqual([
      { value: 'a', label: 'Ay' },
      { value: 'b', label: 'Bee' },
    ]);
  });
});

describe('grouped sources — tenancy guards hold on UNDECLARED hops (adversarial findings)', () => {
  // The natural production spelling: groupBy-only source, tenancy carried entirely
  // by mapDefaults applies-everywhere wheres. No declared relation nodes — the
  // guard must fold anyway, because the join always ships.
  const tenanted = (): LensNarrowing =>
    withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
      mapDefaults: {
        app: {
          models: {
            IntegrationMap: {
              where: { field: 'brandId', operator: Operator.equals, value: 'b1' },
            },
            FieldDef: {
              where: { field: 'id', operator: Operator.notEquals, value: 'hidden' },
            },
          },
        },
      },
    });

  test('mapDefaults wheres on traversed models fold into composedWhere with no declared hops', () => {
    const [q] = sourceQueries(tenanted());
    expect(q.composedWhere).toEqual({
      all: [
        { field: 'map.brandId', operator: Operator.equals, value: 'b1' },
        { field: 'map.definition.id', operator: Operator.notEquals, value: 'hidden' },
      ],
    });
  });

  test('in-memory executor excludes rows failing an undeclared-hop guard', () => {
    const rows = [
      {
        id: 'u1',
        enrichments: [
          {
            value: 'kept',
            map: { brandId: 'b1', definition: { id: 'd1', label: 'business unit' } },
          },
          { value: 'foreign', map: { brandId: 'b2', definition: { id: 'd2', label: 'SECRET' } } },
          {
            value: 'shadow',
            map: { brandId: 'b1', definition: { id: 'hidden', label: 'HIDDEN' } },
          },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(tenanted(), rows);
    expect(sv.options).toEqual([{ value: 'kept', groups: ['business unit'] }]);
  });

  test('a declared first hop does not drop the guard on the undeclared deeper hop', () => {
    const partial = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
            relations: {
              map: {
                picks: [],
                where: { field: 'brandId', operator: Operator.equals, value: 'b1' },
              },
            },
          },
        },
      },
      mapDefaults: {
        app: {
          models: {
            FieldDef: {
              where: { field: 'id', operator: Operator.notEquals, value: 'hidden' },
            },
          },
        },
      },
    });
    const [q] = sourceQueries(partial);
    expect(q.composedWhere).toEqual({
      all: [
        { field: 'map.brandId', operator: Operator.equals, value: 'b1' },
        { field: 'map.definition.id', operator: Operator.notEquals, value: 'hidden' },
      ],
    });
  });
});

describe('exposedSurface — grouped options survive the per-model union', () => {
  test('options sharing a value across groups are all preserved', () => {
    const sourceValues: SourceValues[] = [
      {
        path: 'User.enrichments',
        mapName: 'app',
        model: 'Enrichment',
        field: 'value',
        options: [
          { value: 'marketing', groups: ['business unit'] },
          { value: 'marketing', groups: ['department'] },
        ],
      },
    ];
    const surface = exposedSurface(grouped(), { sourceValues });
    expect(surface.maps.app.models.Enrichment.fields.value.options).toEqual([
      { value: 'marketing', groups: ['business unit'] },
      { value: 'marketing', groups: ['department'] },
    ]);
  });
});

describe('validateNarrowing — conflicting groupBy across layers', () => {
  const parentLayer = (): LensNarrowing =>
    withParent(base, {
      root: {
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
    });

  test('a child layer declaring a DIFFERENT groupBy for the same field is an error', () => {
    const child = withParent(parentLayer(), {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: 'mapId' } } },
        },
      },
    });
    expect(() => validateNarrowing(child)).toThrow(/groupBy/);
  });

  test('a child layer re-declaring the SAME groupBy is fine', () => {
    const child = withParent(parentLayer(), {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: 'map.definition.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(child)).not.toThrow();
  });
});

describe('option sort — ungrouped is its own leading tier', () => {
  test('ungrouped options precede every group, including the empty-string group', () => {
    const n = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
    });
    const rows = [
      {
        id: 'u1',
        enrichments: [
          { value: 'zzz', map: null }, // ungrouped
          { value: 'aaa', map: { definition: { label: '' } } }, // real empty-string group
          { value: 'mmm', map: { definition: { label: 'B' } } },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(n, rows);
    expect(sv.options).toEqual([
      { value: 'zzz' },
      { value: 'aaa', groups: [''] },
      { value: 'mmm', groups: ['B'] },
    ]);
  });
});

describe('validateNarrowing — "__group" is reserved on grouped sources', () => {
  const collisionMap: FieldMap = {
    models: {
      Thing: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          __group: { kind: 'scalar', type: 'String' },
          catId: { kind: 'scalar', type: 'String' },
          cat: { kind: 'object', type: 'Cat', fromFields: ['catId'], toFields: ['id'] },
        },
      },
      Cat: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const collisionBase: Lens = { maps: { app: collisionMap }, mapName: 'app', model: 'Thing' };

  test('rejects a grouped source on a field named __group', () => {
    const n = withParent(collisionBase, {
      root: { picks: ['__group'], sources: { __group: { groupBy: 'cat.name' } } },
    });
    expect(() => validateNarrowing(n)).toThrow(/__group/);
  });

  test('rejects a grouped source whose label column is named __group', () => {
    const n = withParent(collisionBase, {
      root: { picks: ['id'], sources: { id: { label: '__group', groupBy: 'cat.name' } } },
    });
    expect(() => validateNarrowing(n)).toThrow(/__group/);
  });

  test('ungrouped sources may still use a __group column (no alias in play)', () => {
    const n = withParent(collisionBase, {
      root: { picks: ['id'], sources: { id: { label: '__group' } } },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });
});

describe('groupBy/label — ancestor removals bind materialization targets', () => {
  // Within one layer, visibility ≠ materialization: an author may groupBy/label
  // their own unpicked columns. But a PARENT layer's removals bind descendants —
  // otherwise a child source could exfiltrate a locked-down column's values
  // through the option channel (group keys / display labels are client-visible).

  test('own-layer unpicked targets stay allowed (single layer)', () => {
    const n = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { label: 'mapId', groupBy: 'map.definition.label' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });

  test("a hop excluded by an ancestor node's picks is an error", () => {
    // Parent narrows the enrichments node to picks: ['value'] — the `map`
    // relation is removed there, so a child groupBy may not traverse it.
    const parent = withParent(base, {
      root: {
        picks: ['id'],
        relations: { enrichments: { picks: ['value'] } },
      },
    });
    const child = withParent(parent, {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: 'map.definition.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(child)).toThrow(/ancestor/);
  });

  test('a hop the ancestor declares as a relation stays traversable', () => {
    const parent = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: { picks: ['value'], relations: { map: {} } },
        },
      },
    });
    const child = withParent(parent, {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: 'map.definition.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(child)).not.toThrow();
  });

  test('a terminal column omitted by an ancestor mapDefaults is an error', () => {
    const parent = withParent(base, {
      mapDefaults: { app: { models: { FieldDef: { omits: ['label'] } } } },
    });
    const child = withParent(parent, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(child)).toThrow(/ancestor/);
  });

  test('a label column omitted by an ancestor is an error', () => {
    const parent = withParent(base, {
      mapDefaults: { app: { models: { Enrichment: { omits: ['mapId'] } } } },
    });
    const child = withParent(parent, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: { picks: ['value'], sources: { value: { label: 'mapId' } } },
        },
      },
    });
    expect(() => validateNarrowing(child)).toThrow(/ancestor/);
  });
});

describe('asymmetric traversal — the same model narrowed differently per path', () => {
  // A model has no canonical schema: its shape is composed per VISIT. Two sibling
  // paths reach the same Enrichment model; each grouped source must compose only
  // its own path's narrowing — plus mapDefaults, the one symmetric layer.
  const twoPathMap: FieldMap = {
    models: {
      ...map.models,
      User: {
        fields: {
          ...map.models.User.fields,
          archived: {
            kind: 'object',
            type: 'Enrichment',
            isList: true,
            fromFields: ['id'],
            toFields: ['userId'],
          },
        },
      },
    },
  };
  const twoPathBase: Lens = { maps: { app: twoPathMap }, mapName: 'app', model: 'User' };

  const asym = (): LensNarrowing =>
    withParent(twoPathBase, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
            relations: {
              map: { where: { field: 'brandId', operator: Operator.equals, value: 'b1' } },
            },
          },
          archived: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
            relations: {
              map: { where: { field: 'brandId', operator: Operator.equals, value: 'b2' } },
            },
          },
        },
      },
    });

  test('each grouped source composes only its own path narrowing', () => {
    const byPath = Object.fromEntries(sourceQueries(asym()).map((query) => [query.path, query]));
    expect(byPath['User.enrichments'].composedWhere).toEqual({
      field: 'map.brandId',
      operator: Operator.equals,
      value: 'b1',
    });
    expect(byPath['User.archived'].composedWhere).toEqual({
      field: 'map.brandId',
      operator: Operator.equals,
      value: 'b2',
    });
  });

  test('mapDefaults folds into every path; declared narrowing stays per-visit', () => {
    const n = withParent(twoPathBase, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
            relations: {
              map: { where: { field: 'brandId', operator: Operator.equals, value: 'b1' } },
            },
          },
          archived: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
      mapDefaults: {
        app: {
          models: {
            FieldDef: { where: { field: 'id', operator: Operator.notEquals, value: 'hidden' } },
          },
        },
      },
    });
    const byPath = Object.fromEntries(sourceQueries(n).map((query) => [query.path, query]));
    expect(byPath['User.enrichments'].composedWhere).toEqual({
      all: [
        { field: 'map.brandId', operator: Operator.equals, value: 'b1' },
        { field: 'map.definition.id', operator: Operator.notEquals, value: 'hidden' },
      ],
    });
    expect(byPath['User.archived'].composedWhere).toEqual({
      field: 'map.definition.id',
      operator: Operator.notEquals,
      value: 'hidden',
    });
  });

  test('in-memory: identical rows yield a different grouped vocabulary per path', () => {
    const enrichmentRows = [
      { value: 'engineering', map: { brandId: 'b1', definition: { label: 'department' } } },
      { value: 'acme', map: { brandId: 'b2', definition: { label: 'account' } } },
    ];
    const rows = [{ id: 'u1', enrichments: enrichmentRows, archived: enrichmentRows }];
    const byPath = Object.fromEntries(
      sourceValuesFromRows(asym(), rows).map((sv) => [sv.path, sv]),
    );
    expect(byPath['User.enrichments'].options).toEqual([
      { value: 'engineering', groups: ['department'] },
    ]);
    expect(byPath['User.archived'].options).toEqual([{ value: 'acme', groups: ['account'] }]);
  });

  test('an ancestor removal on one path does not bind the sibling path', () => {
    const parent = withParent(twoPathBase, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: { picks: ['value'] }, // map removed on this visit only
          archived: { picks: ['value'], relations: { map: {} } },
        },
      },
    });
    const throughKeptPath = withParent(parent, {
      root: {
        relations: {
          archived: { sources: { value: { groupBy: 'map.definition.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(throughKeptPath)).not.toThrow();

    const throughRemovedPath = withParent(parent, {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: 'map.definition.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(throughRemovedPath)).toThrow(/ancestor/);
  });
});
