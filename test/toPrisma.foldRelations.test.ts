import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Condition, createLens, type LensNarrowing, Operator, toPrisma } from '../index';
import { foldRelationFilters } from '../src/toPrisma/foldRelations';
import { getWhere } from './fixtures/helpers';
import { agree, openRails, map as railsMap } from './rails/harness';

// Prisma emits one LEFT JOIN per relation-filter object. Sibling filters on the same to-one
// relation under one AND read the same (at most one) related row, so they fold into one object:
// `{ AND: [{ rel: A }, { rel: B }] }` → `{ rel: { AND: [A, B] } }`. A to-many filter, an OR and a
// NOT are never folded across. An OR arm asking for the relation to be absent, beside a sibling
// that requires it present, can never hold and drops out.

const map = {
  models: {
    Enrichment: {
      fields: {
        id: { kind: 'scalar', type: 'String', isRequired: true },
        value: { kind: 'scalar', type: 'String', isRequired: false },
        integrationMap: { kind: 'object', type: 'IntegrationMap', isRequired: false },
        tags: { kind: 'object', type: 'Tag', isList: true },
      },
    },
    IntegrationMap: {
      fields: {
        brandId: { kind: 'scalar', type: 'String', isRequired: true },
        deletedAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
        customFieldDefinition: {
          kind: 'object',
          type: 'CustomFieldDefinition',
          isRequired: false,
        },
      },
    },
    CustomFieldDefinition: {
      fields: {
        label: { kind: 'scalar', type: 'String', isRequired: false },
        deletedAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
      },
    },
    Tag: { fields: { name: { kind: 'scalar', type: 'String', isRequired: false } } },
  },
} as never;

const fold = (where: Record<string, unknown>) => foldRelationFilters(where, map, 'Enrichment');

const BRAND = { brandId: { equals: 'b1' } };
const LIVE = { deletedAt: { equals: null } };
const LABEL = { customFieldDefinition: { label: { equals: 'Industry' } } };

describe('foldRelationFilters — siblings on one to-one relation share one filter', () => {
  it('folds two siblings', () => {
    expect(fold({ AND: [{ integrationMap: BRAND }, { integrationMap: LIVE }] })).toEqual({
      integrationMap: { AND: [BRAND, LIVE] },
    });
  });

  it('folds three siblings, keeping the other conjuncts in place', () => {
    const value = { value: { equals: 'Tech' } };
    expect(
      fold({
        AND: [
          { integrationMap: BRAND },
          value,
          { integrationMap: LIVE },
          { integrationMap: LABEL },
        ],
      }),
    ).toEqual({ AND: [{ integrationMap: { AND: [BRAND, LIVE, LABEL] } }, value] });
  });

  it('folds across nested ANDs and multi-key objects', () => {
    expect(
      fold({ AND: [{ AND: [{ integrationMap: BRAND }] }, { integrationMap: LIVE, id: 'x' }] }),
    ).toEqual({ AND: [{ integrationMap: { AND: [BRAND, LIVE] } }, { id: 'x' }] });
  });

  it('treats `is` as the bare form', () => {
    expect(fold({ AND: [{ integrationMap: { is: BRAND } }, { integrationMap: LIVE }] })).toEqual({
      integrationMap: { is: { AND: [BRAND, LIVE] } },
    });
    expect(fold({ AND: [{ integrationMap: { is: {} } }, { integrationMap: LIVE }] })).toEqual({
      integrationMap: { is: LIVE },
    });
  });

  it('recurses into the folded relation', () => {
    const cfdLive = { customFieldDefinition: LIVE };
    expect(fold({ AND: [{ integrationMap: cfdLive }, { integrationMap: LABEL }] })).toEqual({
      integrationMap: {
        customFieldDefinition: { AND: [LIVE, { label: { equals: 'Industry' } }] },
      },
    });
  });

  it('recurses into OR arms, NOT and to-many filters without folding across them', () => {
    const pair = { AND: [{ integrationMap: BRAND }, { integrationMap: LIVE }] };
    const folded = { integrationMap: { AND: [BRAND, LIVE] } };
    expect(fold({ OR: [pair, { id: 'x' }] })).toEqual({ OR: [folded, { id: 'x' }] });
    expect(fold({ NOT: pair })).toEqual({ NOT: folded });
    const tagPair = { AND: [{ name: { equals: 'a' } }, { name: { not: 'b' } }] };
    expect(fold({ tags: { some: tagPair } })).toEqual({ tags: { some: tagPair } });
  });

  it('leaves to-many siblings apart: two `some` can be met by different rows', () => {
    const where = {
      AND: [
        { tags: { some: { name: { equals: 'a' } } } },
        { tags: { some: { name: { equals: 'b' } } } },
      ],
    };
    expect(fold(where)).toBe(where);
  });

  it('never folds across OR', () => {
    const where = { OR: [{ integrationMap: BRAND }, { integrationMap: LIVE }] };
    expect(fold(where)).toBe(where);
  });

  it('leaves `isNot`, a bare `{}` and an `is: null` sibling alone', () => {
    for (const other of [{ isNot: LIVE }, {}, { is: null }]) {
      const where = { AND: [{ integrationMap: BRAND }, { integrationMap: other }] };
      expect(fold(where)).toBe(where);
    }
  });

  it('without a map nothing folds: the relation kind is unknown', () => {
    const where = { AND: [{ integrationMap: BRAND }, { integrationMap: LIVE }] };
    expect(foldRelationFilters(where, undefined, undefined)).toBe(where);
  });

  it('keeps an absorbing match-nothing inside the folded relation', () => {
    expect(fold({ AND: [{ integrationMap: { OR: [] } }, { integrationMap: LIVE }] })).toEqual({
      integrationMap: { OR: [] },
    });
  });
});

describe('foldRelationFilters — an absent-relation arm beside a present one is dead', () => {
  it('drops `is: null` when a sibling requires the relation', () => {
    expect(
      fold({
        AND: [
          { integrationMap: BRAND },
          { OR: [{ integrationMap: LIVE }, { integrationMap: { is: null } }] },
        ],
      }),
    ).toEqual({ integrationMap: { AND: [BRAND, LIVE] } });
  });

  it('drops a nested hop absence when a sibling requires that hop', () => {
    expect(
      fold({
        AND: [
          { integrationMap: LABEL },
          {
            OR: [
              { integrationMap: { customFieldDefinition: LIVE } },
              { integrationMap: { is: null } },
              { integrationMap: { customFieldDefinition: { is: null } } },
            ],
          },
        ],
      }),
    ).toEqual({
      integrationMap: {
        customFieldDefinition: { AND: [{ label: { equals: 'Industry' } }, LIVE] },
      },
    });
  });

  it('keeps the arm where no sibling requires the relation', () => {
    const where = {
      AND: [
        { value: { equals: 'x' } },
        { OR: [{ integrationMap: LIVE }, { integrationMap: { is: null } }] },
      ],
    };
    expect(fold(where)).toBe(where);
  });

  it('keeps the OR whole when every arm would drop', () => {
    const where = { AND: [{ integrationMap: BRAND }, { OR: [{ integrationMap: { is: null } }] }] };
    expect(fold(where)).toBe(where);
  });
});

describe('toPrisma under a lens — an enrichment clause reads integrationMap once', () => {
  const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Enrichment' });
  const lens: LensNarrowing = {
    parent: base,
    root: { relations: { integrationMap: { relations: { customFieldDefinition: {} } } } },
    mapDefaults: {
      prisma: {
        models: {
          IntegrationMap: {
            where: {
              all: [
                { field: 'brandId', operator: Operator.equals, value: 'b1' },
                { field: 'deletedAt', operator: Operator.notExists },
              ],
            },
          },
          CustomFieldDefinition: { where: { field: 'deletedAt', operator: Operator.notExists } },
        },
      },
    },
  };

  it('compiles to one integrationMap filter and one customFieldDefinition filter', () => {
    const rule: Condition = {
      all: [
        {
          field: 'integrationMap.customFieldDefinition.label',
          operator: Operator.equals,
          value: 'Industry',
        },
        { field: 'value', operator: Operator.equals, value: 'Tech' },
      ],
    };
    expect(getWhere(toPrisma(rule, { lens }))).toEqual({
      AND: [
        {
          integrationMap: {
            AND: [
              BRAND,
              LIVE,
              { customFieldDefinition: { AND: [LIVE, { label: { equals: 'Industry' } }] } },
            ],
          },
        },
        { value: { equals: 'Tech' } },
      ],
    });
  });
});

// The fold changes the shape, never the rows: each where and its fold, run by Prisma on Postgres.
describe('foldRelationFilters — the same rows on a real database', () => {
  let rails: Awaited<ReturnType<typeof openRails>>;
  beforeAll(async () => {
    rails = await openRails();
  });
  afterAll(async () => {
    await rails.close();
  });

  const ids = async (where: Record<string, unknown>) =>
    (
      await rails.prisma.user.findMany({
        where: where as never,
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((row) => row.id);

  const wheres: Record<string, unknown>[] = [
    { AND: [{ org: { plan: { equals: 'pro' } } }, { org: { name: { equals: 'Acme' } } }] },
    { AND: [{ org: { seats: { lt: 10 } } }, { org: { plan: { equals: null } } }] },
    { AND: [{ org: { is: {} } }, { org: { NOT: { plan: { equals: 'pro' } } } }] },
    {
      AND: [
        { org: { parent: { name: { equals: 'Acme' } } } },
        { org: { parent: { plan: { equals: 'pro' } } } },
        { org: { plan: { equals: null } } },
      ],
    },
    {
      AND: [
        { org: { seats: { gte: 0 } } },
        { OR: [{ org: { name: { equals: null } } }, { org: { is: null } }] },
      ],
    },
    {
      AND: [
        { org: { NOT: { plan: { equals: 'pro' } } } },
        { OR: [{ org: { name: { equals: null } } }, { org: { is: null } }] },
      ],
    },
    {
      AND: [
        { org: { parent: { name: { not: 'x' } } } },
        {
          OR: [
            { org: { parent: { plan: { equals: 'free' } } } },
            { org: { is: null } },
            { org: { parent: { is: null } } },
          ],
        },
      ],
    },
  ];

  it('folds each where, and each fold returns the same users', async () => {
    for (const where of wheres) {
      const folded = foldRelationFilters(where, railsMap, 'User');
      expect(folded).not.toEqual(where);
      expect(await ids(folded)).toEqual(await ids(where));
    }
  });

  it('a lens with a to-one clamp: the rails still agree', async () => {
    const base = createLens({ maps: { prisma: railsMap }, mapName: 'prisma', model: 'User' });
    const lens: LensNarrowing = {
      parent: base,
      root: { relations: { org: { relations: { parent: {} } } } },
      mapDefaults: {
        prisma: { models: { Org: { where: { field: 'seats', operator: Operator.exists } } } },
      },
    };
    const rules: Condition[] = [
      { field: 'org.name', operator: Operator.equals, value: 'acme' },
      { field: 'org.parent.plan', operator: Operator.equals, value: 'pro' },
      { field: 'org.name', operator: Operator.notEquals, value: 'Acme' },
      { field: 'org.parent.name', operator: Operator.notEquals, value: 'x' },
    ];
    for (const rule of rules) {
      const result = await rails.run(rule, { lens });
      expect(result).toEqual(agree(result.check as number[]));
    }
  });
});
