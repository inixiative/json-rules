import { describe, expect, test } from 'bun:test';
import { sourceQueries } from '../src/lens/sourceQuery';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap, PrismaWhere } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    Region: {
      fields: {
        code: { kind: 'scalar', type: 'String' },
        active: { kind: 'scalar', type: 'Boolean' },
        countryId: { kind: 'scalar', type: 'String' },
        country: { kind: 'object', type: 'Country', fromFields: ['countryId'], toFields: ['id'] },
        cities: {
          kind: 'object',
          type: 'City',
          isList: true,
          fromFields: ['id'],
          toFields: ['regionId'],
        },
      },
    },
    Country: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        active: { kind: 'scalar', type: 'Boolean' },
      },
    },
    City: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        regionId: { kind: 'scalar', type: 'String' },
        active: { kind: 'scalar', type: 'Boolean' },
      },
    },
  },
};

const base: Lens = { maps: { app: map }, mapName: 'app', model: 'Region' };
const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({
  parent,
  ...rest,
});

const activeWhere: Condition = {
  all: [{ field: 'active', operator: Operator.equals, value: true }],
};

describe('sourceQueries', () => {
  test('compiles a DISTINCT prisma + sql query for a sourced field', () => {
    const n = withParent(base, { root: { sources: { code: activeWhere } } });
    const queries = sourceQueries(n);

    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect({ path: q.path, mapName: q.mapName, model: q.model, field: q.field }).toEqual({
      path: 'Region',
      mapName: 'app',
      model: 'Region',
      field: 'code',
    });

    // prisma: distinct + select + the toPrisma WHERE for the composed condition
    expect(q.prisma.distinct).toEqual(['code']);
    expect(q.prisma.select).toEqual({ code: true });
    const expectedWhere = toPrisma(q.composedWhere, {
      map: base,
      mapName: 'app',
      model: 'Region',
    }).steps.at(-1);
    expect(q.prisma.where).toEqual((expectedWhere as { where: PrismaWhere }).where);

    // sql: a real DISTINCT statement
    expect(q.sql.sql).toBe(
      'SELECT DISTINCT "t0"."code" FROM "Region" AS "t0" WHERE ("t0"."active" = $1)',
    );
    expect(q.sql.params).toEqual([true]);
  });

  test('composes the node where with the source where (AND)', () => {
    const rootWhere: Condition = {
      all: [{ field: 'code', operator: Operator.notEquals, value: '' }],
    };
    const n = withParent(base, { root: { where: rootWhere, sources: { code: activeWhere } } });
    const q = sourceQueries(n)[0];
    expect(q.composedWhere).toEqual({ all: [rootWhere, activeWhere] });
    // both predicates land in the SQL
    expect(q.sql.sql).toContain('"t0"."active" = ');
    expect(q.sql.sql).toContain('"t0"."code" <> ');
  });

  test('a source where that traverses a relation produces a JOIN', () => {
    const n = withParent(base, {
      root: {
        sources: {
          code: { all: [{ field: 'country.active', operator: Operator.equals, value: true }] },
        },
      },
    });
    const q = sourceQueries(n)[0];
    expect(q.sql.sql).toContain('JOIN "Country"');
    expect(q.sql.sql?.startsWith('SELECT DISTINCT "t0"."code" FROM "Region" AS "t0"')).toBe(true);
  });

  test('a relational array predicate compiles Prisma (some) and degrades SQL gracefully', () => {
    const arrayWhere: Condition = {
      all: [
        {
          field: 'cities',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'active', operator: Operator.equals, value: true },
        },
      ],
    };
    const n = withParent(base, { root: { sources: { code: arrayWhere } } });
    const q = sourceQueries(n)[0];

    // Prisma expresses it via `some`
    expect(q.prisma.distinct).toEqual(['code']);
    expect(q.prisma.where).toEqual({ AND: [{ cities: { some: { active: { equals: true } } } }] });

    // SQL cannot — it degrades to null with a captured error rather than throwing
    expect(q.sql.sql).toBeNull();
    expect(q.sql.params).toEqual([]);
    expect(q.sql.error).toContain('not supported in SQL');
  });

  test('a count operator source produces Prisma groupBy steps and degrades SQL', () => {
    const countWhere: Condition = {
      all: [
        {
          field: 'cities',
          arrayOperator: ArrayOperator.atLeast,
          count: 3,
          condition: { field: 'active', operator: Operator.equals, value: true },
        },
      ],
    };
    const n = withParent(base, { root: { sources: { code: countWhere } } });
    const q = sourceQueries(n)[0];

    expect(q.prisma.steps).toBeDefined();
    expect((q.prisma.steps ?? []).some((s) => s.operation === 'groupBy')).toBe(true);
    expect(q.sql.sql).toBeNull();
    expect(q.sql.error).toContain('not supported in SQL');
  });
});
