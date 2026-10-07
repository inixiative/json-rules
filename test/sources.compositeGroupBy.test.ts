import { describe, expect, test } from 'bun:test';
import {
  assertValidNarrowing,
  type Lens,
  type LensNarrowing,
  materializeSourceQuery,
  materializeSources,
  projectLens,
  toSourceQueries,
} from '../index';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Composite groupBy: a source may partition by SEVERAL axes at once — the
// (source, field, value) triple that powers a 3-level cascade. Options carry
// `groups: string[]`, index-aligned with the declared axes. The pairing lives
// on the junction row, so no single-path groupBy can express it.
const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
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
        active: { kind: 'scalar', type: 'Boolean' },
        definition: {
          kind: 'object',
          type: 'FieldDef',
          fromFields: ['id'],
          toFields: ['id'],
        },
        source: {
          kind: 'object',
          type: 'Source',
          fromFields: ['id'],
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
    Source: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        label: { kind: 'scalar', type: 'String' },
        active: { kind: 'scalar', type: 'Boolean' },
      },
    },
  },
};

const base: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };
const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

const AXES = ['map.source.label', 'map.definition.label'];

const composite = (): LensNarrowing =>
  withParent(base, {
    root: {
      picks: ['id'],
      relations: {
        enrichments: {
          picks: ['value'],
          sources: { value: { groupBy: AXES } },
        },
      },
    },
    mapDefaults: {
      app: {
        models: {
          IntegrationMap: {
            where: { field: 'brandId', operator: Operator.equals, value: 'b1' },
          },
        },
      },
    },
  });

const row = (value: string, source: string | null, def: string | null, brandId = 'b1') => ({
  value,
  map: {
    brandId,
    definition: def === null ? null : { label: def },
    source: source === null ? null : { label: source },
  },
});

describe('validateNarrowing — composite groupBy', () => {
  test('accepts an array of to-one scalar-terminal paths', () => {
    expect(() => assertValidNarrowing(composite())).not.toThrow();
  });

  test('a single-string groupBy still validates (normalized form)', () => {
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
    expect(() => assertValidNarrowing(n)).not.toThrow();
  });

  test('each axis is validated — a to-many hop in ANY axis is an error', () => {
    const n = withParent(base, {
      root: {
        picks: ['id', 'enrichments'],
        sources: { id: { groupBy: ['enrichments.value'] } },
      },
    });
    expect(() => assertValidNarrowing(n)).toThrow(/to-many/i);
  });

  test('cross-layer conflict compares normalized axes — [a] vs a is NOT a conflict', () => {
    const parent = withParent(base, {
      root: {
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
        },
      },
    });
    const child = withParent(parent, {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: ['map.definition.label'] } } },
        },
      },
    });
    expect(() => assertValidNarrowing(child)).not.toThrow();
  });

  test('cross-layer conflict on genuinely different axes is an error', () => {
    const parent = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['value'], sources: { value: { groupBy: AXES } } },
        },
      },
    });
    const child = withParent(parent, {
      root: {
        relations: {
          enrichments: { sources: { value: { groupBy: ['map.definition.label'] } } },
        },
      },
    });
    expect(() => assertValidNarrowing(child)).toThrow(/conflict|differ/i);
  });

  test('indexed alias names are reserved on grouped sources', () => {
    const collisionMap: FieldMap = {
      models: {
        Thing: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            __group_1: { kind: 'scalar', type: 'String' },
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
    const n = withParent(collisionBase, {
      root: { picks: ['__group_1'], sources: { __group_1: { groupBy: 'cat.name' } } },
    });
    expect(() => assertValidNarrowing(n)).toThrow(/__group/);
  });
});

describe('toSourceQueries — composite compile', () => {
  test('SourceQuery.groupBy is the normalized axes array', () => {
    const [q] = toSourceQueries(composite());
    expect(q.groupBy).toEqual(AXES);
  });

  test('a single-string declaration normalizes to a one-element axes array', () => {
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
    const [q] = toSourceQueries(n);
    expect(q.groupBy).toEqual(['map.definition.label']);
  });

  test('prisma select nests every axis; distinct stays absent', () => {
    const [q] = toSourceQueries(composite());
    expect(q.prisma.distinct).toBeUndefined();
    expect(q.prisma.select).toEqual({
      value: true,
      map: {
        select: {
          source: { select: { label: true } },
          definition: { select: { label: true } },
        },
      },
    });
  });

  test('sql aliases each axis as __group_i', () => {
    const [q] = toSourceQueries(composite());
    expect(q.sql.sql).toContain('AS "__group_0"');
    expect(q.sql.sql).toContain('AS "__group_1"');
  });

  test('guards fold ONCE per traversed hop across shared axis prefixes', () => {
    const [q] = toSourceQueries(composite());
    // Both axes traverse `map` — the IntegrationMap mapDefaults brand guard must
    // appear exactly once, not once per axis.
    expect(q.composedWhere).toEqual({
      field: 'map.brandId',
      operator: Operator.equals,
      value: 'b1',
    });
  });
});

describe('toSourceQueries — source-where hop guards (hardening)', () => {
  test('a where clause traversing an off-groupBy relation folds that hop guard', () => {
    const n = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: {
              value: {
                // The where reaches Source; groupBy does NOT — the Source-model
                // guard must fold anyway, because the where ships the join.
                where: { field: 'map.source.active', operator: Operator.equals, value: true },
                groupBy: 'map.definition.label',
              },
            },
          },
        },
      },
      mapDefaults: {
        app: {
          models: {
            Source: { where: { field: 'active', operator: Operator.equals, value: true } },
            IntegrationMap: {
              where: { field: 'brandId', operator: Operator.equals, value: 'b1' },
            },
          },
        },
      },
    });
    const [q] = toSourceQueries(n);
    expect(q.composedWhere).toEqual({
      all: [
        { field: 'map.source.active', operator: Operator.equals, value: true },
        { field: 'map.brandId', operator: Operator.equals, value: 'b1' },
        { field: 'map.source.active', operator: Operator.equals, value: true },
      ],
    });
  });
});

describe('materialization — options carry index-aligned groups', () => {
  test('in-memory rows yield groups arrays; dedup is per (groups, value)', () => {
    const rows = [
      {
        id: 'u1',
        enrichments: [
          row('Manufacturing', 'Salesforce', 'Industry'),
          row('Manufacturing', 'Salesforce', 'Industry'), // duplicate
          row('Manufacturing', 'HubSpot', 'Industry'), // same value, other source
          row('marketing', 'Salesforce', 'Business Unit'),
          row('foreign', 'Salesforce', 'Industry', 'b2'), // guard-excluded
        ],
      },
    ];
    const [sv] = materializeSources(composite(), rows);
    // Axes sort lexicographically, first axis outermost: HubSpot < Salesforce,
    // then Business Unit < Industry within Salesforce.
    expect(sv.options).toEqual([
      { value: 'Manufacturing', groups: ['HubSpot', 'Industry'] },
      { value: 'marketing', groups: ['Salesforce', 'Business Unit'] },
      { value: 'Manufacturing', groups: ['Salesforce', 'Industry'] },
    ]);
  });

  test('an unreachable axis (null hop) leaves the option ungrouped — never partial', () => {
    const rows = [
      {
        id: 'u1',
        enrichments: [row('orphan', null, 'Industry'), row('kept', 'Salesforce', 'Industry')],
      },
    ];
    const [sv] = materializeSources(composite(), rows);
    expect(sv.options).toEqual([
      { value: 'orphan' },
      { value: 'kept', groups: ['Salesforce', 'Industry'] },
    ]);
  });

  test('materializeSourceQuery: prisma-shaped rows nest each axis', () => {
    const [q] = toSourceQueries(composite());
    const sv = materializeSourceQuery(q, [
      {
        value: 'Manufacturing',
        map: { source: { label: 'Salesforce' }, definition: { label: 'Industry' } },
      },
      {
        value: 'marketing',
        map: { source: { label: 'Salesforce' }, definition: { label: 'Business Unit' } },
      },
    ]);
    expect(sv.options).toEqual([
      { value: 'marketing', groups: ['Salesforce', 'Business Unit'] },
      { value: 'Manufacturing', groups: ['Salesforce', 'Industry'] },
    ]);
  });

  test('materializeSourceQuery: sql-shaped rows read the indexed aliases', () => {
    const [q] = toSourceQueries(composite());
    const sv = materializeSourceQuery(
      q,
      [{ value: 'Manufacturing', __group_0: 'Salesforce', __group_1: 'Industry' }],
      { rowShape: 'sql' },
    );
    expect(sv.options).toEqual([{ value: 'Manufacturing', groups: ['Salesforce', 'Industry'] }]);
  });
});

describe('projectModels — axes on the surface, groups in the union', () => {
  test('the surface field entry carries the partition axes', () => {
    const surface = projectLens(composite(), { by: 'model' });
    expect(surface.maps.app.models.Enrichment.fields.value.groupBy).toEqual(AXES);
  });

  test('options sharing a value across composite groups survive the union', () => {
    const surface = projectLens(composite(), {
      ...{
        sourceValues: [
          {
            path: 'User.enrichments',
            mapName: 'app',
            model: 'Enrichment',
            field: 'value',
            options: [
              { value: 'Manufacturing', groups: ['Salesforce', 'Industry'] },
              { value: 'Manufacturing', groups: ['HubSpot', 'Industry'] },
            ],
          },
        ],
      },
      by: 'model',
    });
    expect(surface.maps.app.models.Enrichment.fields.value.options).toEqual([
      { value: 'Manufacturing', groups: ['Salesforce', 'Industry'] },
      { value: 'Manufacturing', groups: ['HubSpot', 'Industry'] },
    ]);
  });

  test('divergent axes for the same (model, field) across paths is an error', () => {
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
    const n = withParent(twoPathBase, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: { value: { groupBy: 'map.definition.label' } },
          },
          archived: { picks: ['value'], sources: { value: { groupBy: 'map.source.label' } } },
        },
      },
    });
    expect(() => projectLens(n, { by: 'model' })).toThrow(/ax[ei]s|groupBy/i);
  });
});
