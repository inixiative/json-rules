import { describe, expect, test } from 'bun:test';
import {
  type Lens,
  type LensNarrowing,
  projectByPath,
  type SourceSpec,
  sourceQueries,
  sourceValuesFromQueryRows,
  sourceValuesFromRows,
  validateNarrowing,
} from '../index';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Same EAV shape the groupBy suite uses: the display name of an Enrichment's map
// lives two to-one hops away, on FieldDef.label — a label the option picker needs
// and a sibling column cannot reach.
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

// The canonical case: pick the map id, display the definition's label.
const pathLabeled = (): LensNarrowing =>
  withParent(base, {
    root: {
      picks: ['id'],
      relations: {
        enrichments: {
          picks: ['mapId'],
          sources: { mapId: { label: 'map.definition.label' } },
        },
      },
    },
  });

describe('validateNarrowing — a dotted label is validated like a groupBy axis', () => {
  test('accepts a label path through to-one relations ending on a scalar', () => {
    expect(() => validateNarrowing(pathLabeled())).not.toThrow();
  });

  test('rejects an unknown segment', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['mapId'], sources: { mapId: { label: 'map.nope.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/label/);
  });

  test('rejects a to-many hop', () => {
    const n = withParent(base, {
      root: { picks: ['tier'], sources: { tier: { label: 'enrichments.value' } } },
    });
    expect(() => validateNarrowing(n)).toThrow(/label cannot traverse to-many/);
  });

  test('rejects a path ending on a relation', () => {
    const n = withParent(base, {
      root: {
        relations: {
          enrichments: { picks: ['mapId'], sources: { mapId: { label: 'map.definition' } } },
        },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/label must end on a scalar column/);
  });

  test("a hop excluded by an ancestor node's picks is an error", () => {
    const parent = withParent(base, {
      root: { picks: ['id'], relations: { enrichments: { picks: ['mapId'] } } },
    });
    const child = withParent(parent, {
      root: {
        relations: {
          enrichments: { sources: { mapId: { label: 'map.definition.label' } } },
        },
      },
    });
    expect(() => validateNarrowing(child)).toThrow(/ancestor/);
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
            picks: ['mapId'],
            sources: { mapId: { label: 'map.definition.label' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(child)).toThrow(/ancestor/);
  });
});

describe('projectByPath — a dotted label surfaces verbatim', () => {
  test('sourceLabels carries the path, not a column name', () => {
    const visit = projectByPath(pathLabeled()).get('User.enrichments');
    expect(visit?.sourceLabels).toEqual({ mapId: 'map.definition.label' });
  });
});

describe('sourceQueries — dotted label compile', () => {
  test('nests the label path into the prisma select and keeps DISTINCT on the value', () => {
    const [q] = sourceQueries(pathLabeled());
    expect(q.label).toBe('map.definition.label');
    expect(q.prisma.distinct).toEqual(['mapId']);
    expect(q.prisma.select).toEqual({
      mapId: true,
      map: { select: { definition: { select: { label: true } } } },
    });
  });

  test('selects the joined label column aliased "__label" in sql', () => {
    const [q] = sourceQueries(pathLabeled());
    expect(q.sql.sql).toBe(
      'SELECT DISTINCT "t0"."mapId", "t2"."label" AS "__label" FROM "Enrichment" AS "t0" ' +
        'LEFT JOIN "IntegrationMap" AS "t1" ON "t1"."id" = "t0"."mapId" ' +
        'LEFT JOIN "FieldDef" AS "t2" ON "t2"."id" = "t1"."definitionId" WHERE TRUE',
    );
    expect(q.sql.params).toEqual([]);
  });

  test('the hops a label path names carry their narrowing guards, like an axis', () => {
    const tenanted = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['mapId'],
            sources: { mapId: { label: 'map.definition.label' } },
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
    const [q] = sourceQueries(tenanted);
    expect(q.composedWhere).toEqual({
      all: [
        { field: 'map.brandId', operator: Operator.equals, value: 'b1' },
        { field: 'map.definition.id', operator: Operator.notEquals, value: 'hidden' },
      ],
    });
    expect(q.sql.sql).toContain('AS "__label"');
    expect(q.sql.sql).toContain('WHERE');
  });

  test('a label sharing a prefix with a groupBy axis merges into one nested select', () => {
    const n = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['value'],
            sources: {
              value: { label: 'map.definition.id', groupBy: 'map.definition.label' },
            },
          },
        },
      },
    });
    const [q] = sourceQueries(n);
    expect(q.prisma.select).toEqual({
      value: true,
      map: { select: { definition: { select: { label: true, id: true } } } },
    });
    // one join per hop, shared by both paths
    expect(q.sql.sql?.match(/LEFT JOIN/g)).toHaveLength(2);
    expect(q.sql.sql).toContain('AS "__label"');
    expect(q.sql.sql).toContain('AS "__group_0"');
  });

  test('hop guards fold once when the label and the axis share a prefix', () => {
    const shared = (spec: SourceSpec): LensNarrowing =>
      withParent(base, {
        root: {
          picks: ['id'],
          relations: { enrichments: { picks: ['value'], sources: { value: spec } } },
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
    const [axisOnly] = sourceQueries(shared({ groupBy: 'map.definition.label' }));
    const [both] = sourceQueries(
      shared({ groupBy: 'map.definition.label', label: 'map.definition.id' }),
    );
    expect(both.composedWhere).toEqual(axisOnly.composedWhere);
  });

  test('an unresolvable label hop is fail-closed, like an axis', () => {
    const n = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: { picks: ['mapId'], sources: { mapId: { label: 'value.deeper' } } },
        },
      },
    });
    expect(() => sourceQueries(n)).toThrow(/label 'value\.deeper'/);
  });
});

describe('sourceValuesFromQueryRows — dotted label materialization', () => {
  test('reads the label off prisma-shaped nested rows', () => {
    const [q] = sourceQueries(pathLabeled());
    const sv = sourceValuesFromQueryRows(q, [
      { mapId: 'm2', map: { definition: { label: 'Industry' } } },
      { mapId: 'm1', map: { definition: { label: 'Business Unit' } } },
    ]);
    expect(sv).toEqual({
      path: 'User.enrichments',
      mapName: 'app',
      model: 'Enrichment',
      field: 'mapId',
      options: [
        { value: 'm1', label: 'Business Unit' },
        { value: 'm2', label: 'Industry' },
      ],
    });
  });

  test('sql row shape reads the "__label" alias explicitly', () => {
    const [q] = sourceQueries(pathLabeled());
    const sv = sourceValuesFromQueryRows(q, [{ mapId: 'm1', __label: 'Industry' }], {
      rowShape: 'sql',
    });
    expect(sv.options).toEqual([{ value: 'm1', label: 'Industry' }]);
  });

  test('an unreachable label hop leaves the option unlabeled', () => {
    const [q] = sourceQueries(pathLabeled());
    const sv = sourceValuesFromQueryRows(q, [{ mapId: 'm1', map: null }]);
    expect(sv.options).toEqual([{ value: 'm1' }]);
  });

  test('prisma rows never read a stray flat "__label" column', () => {
    const [q] = sourceQueries(pathLabeled());
    const sv = sourceValuesFromQueryRows(q, [{ mapId: 'm1', map: null, __label: 'STRAY' }]);
    expect(sv.options).toEqual([{ value: 'm1' }]);
  });
});

describe('sourceValuesFromRows — dotted label from an already-fetched collection', () => {
  test('labels come off the nested rows, first non-null wins', () => {
    const rows = [
      {
        id: 'u1',
        enrichments: [
          { mapId: 'm1', map: { definition: { label: 'Business Unit' } } },
          { mapId: 'm1', map: { definition: { label: 'Ignored Duplicate' } } },
          { mapId: 'm2', map: null },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(pathLabeled(), rows);
    expect(sv.options).toEqual([{ value: 'm1', label: 'Business Unit' }, { value: 'm2' }]);
  });

  test('a guarded hop still excludes the row, label or not', () => {
    const guarded = withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: {
            picks: ['mapId'],
            sources: { mapId: { label: 'map.definition.label' } },
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
    const rows = [
      {
        id: 'u1',
        enrichments: [
          { mapId: 'm1', map: { brandId: 'b1', definition: { label: 'Kept' } } },
          { mapId: 'm2', map: { brandId: 'b2', definition: { label: 'Foreign' } } },
        ],
      },
    ];
    const [sv] = sourceValuesFromRows(guarded, rows);
    expect(sv.options).toEqual([{ value: 'm1', label: 'Kept' }]);
  });
});

describe('mutation control — a sibling label is untouched by the path spelling', () => {
  const sibling = (): LensNarrowing =>
    withParent(base, {
      root: {
        picks: ['id'],
        relations: {
          enrichments: { picks: ['mapId'], sources: { mapId: { label: 'value' } } },
        },
      },
    });

  test('prisma select stays flat and sql keeps the bare column, no "__label" alias', () => {
    const [q] = sourceQueries(sibling());
    expect(q.prisma.select).toEqual({ mapId: true, value: true });
    expect(q.sql.sql).toBe(
      'SELECT DISTINCT "t0"."mapId", "t0"."value" FROM "Enrichment" AS "t0" WHERE TRUE',
    );
    expect(q.sql.sql).not.toContain('__label');
  });

  test('both executors still read a sibling label off the flat row', () => {
    const [q] = sourceQueries(sibling());
    expect(sourceValuesFromQueryRows(q, [{ mapId: 'm1', value: 'Sibling' }]).options).toEqual([
      { value: 'm1', label: 'Sibling' },
    ]);
    expect(
      sourceValuesFromQueryRows(q, [{ mapId: 'm1', value: 'Sibling' }], { rowShape: 'sql' })
        .options,
    ).toEqual([{ value: 'm1', label: 'Sibling' }]);
    const [sv] = sourceValuesFromRows(sibling(), [
      { id: 'u1', enrichments: [{ mapId: 'm1', value: 'Sibling' }] },
    ]);
    expect(sv.options).toEqual([{ value: 'm1', label: 'Sibling' }]);
  });
});
