import { describe, expect, test } from 'bun:test';
import {
  type Lens,
  type LensNarrowing,
  projectByPath,
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
    expect(visit?.sourceGroupBys).toEqual({ value: 'map.definition.label' });
  });
});

describe('sourceQueries — grouped compile', () => {
  test('carries groupBy, drops distinct, nests the group path into the prisma select', () => {
    const [q] = sourceQueries(grouped());
    expect(q.groupBy).toBe('map.definition.label');
    expect(q.prisma.distinct).toBeUndefined();
    expect(q.prisma.select).toEqual({
      value: true,
      map: { select: { definition: { select: { label: true } } } },
    });
  });

  test('selects the joined group column as "__group" in sql', () => {
    const [q] = sourceQueries(grouped());
    expect(q.sql.sql).toContain('SELECT DISTINCT');
    expect(q.sql.sql).toContain('AS "__group"');
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
      { value: 'marketing', group: 'business unit' },
      { value: 'sales', group: 'business unit' },
      { value: 'dup', group: 'department' },
      { value: 'marketing', group: 'department' },
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
    expect(sv.options).toEqual([{ value: 'orphan' }, { value: 'grouped', group: 'business unit' }]);
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
        { value: 'marketing', group: 'business unit' },
        { value: 'sales', group: 'department' },
      ],
    });
  });

  test('reads the sql "__group" alias when the row is flat', () => {
    const [q] = sourceQueries(grouped());
    const sv = sourceValuesFromQueryRows(q, [{ value: 'marketing', __group: 'business unit' }]);
    expect(sv.options).toEqual([{ value: 'marketing', group: 'business unit' }]);
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
