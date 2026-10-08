import { describe, expect, test } from 'bun:test';
import {
  type Condition,
  type FieldMap,
  type Lens,
  type LensNarrowing,
  projectRows,
  toLensSelect,
} from '../index';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        status: { kind: 'scalar', type: 'String' },
        meta: { kind: 'scalar', type: 'Json' },
        org: { kind: 'object', type: 'Org' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Org: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        plan: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        owner: { kind: 'object', type: 'User' },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        tag: { kind: 'object', type: 'Tag' },
        comments: { kind: 'object', type: 'Comment', isList: true },
      },
    },
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        postId: { kind: 'scalar', type: 'String' },
        post: { kind: 'object', type: 'Post', fromFields: ['postId'], toFields: ['id'] },
      },
    },
    Tag: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        ownerModel: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const base: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };
const live: Condition = { field: 'deletedAt', operator: 'notExists' };

describe('toLensSelect', () => {
  test('selects the visible columns of each declared path; a declared relation nests', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id', 'org'], relations: { org: { picks: ['name'] } } },
    };
    expect(toLensSelect(lens)).toEqual({
      select: { id: true, org: { select: { name: true } } },
    });
  });

  test('a visible relation off the declared paths brings its visible columns, no relations', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { omits: ['posts', 'meta'] },
      mapDefaults: { prisma: { models: { Org: { omits: ['deletedAt'] } } } },
    };
    expect(toLensSelect(lens).select).toEqual({
      id: true,
      name: true,
      email: true,
      status: true,
      org: { select: { id: true, name: true, plan: true } },
    });
  });

  test("a to-many relation carries its visit's grants as its where; its grant columns are selected", () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'posts'],
        relations: { posts: { picks: ['title'], where: live } },
      },
    };
    expect(toLensSelect(lens).select).toEqual({
      id: true,
      posts: { select: { title: true, deletedAt: true }, where: { deletedAt: { equals: null } } },
    });
  });

  test("a to-one relation's grant can't ride the select: its columns come, it carries no where", () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['org'], relations: { org: { picks: ['name'], where: live } } },
    };
    expect(toLensSelect(lens).select).toEqual({
      org: { select: { name: true, deletedAt: true } },
    });
  });

  test('a grant reaching through a hidden relation selects just the columns it reads', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'posts'],
        relations: {
          posts: {
            picks: ['title'],
            where: { field: 'tag.ownerModel', operator: 'equals', value: 'platform' },
          },
        },
      },
    };
    expect(toLensSelect(lens).select).toEqual({
      id: true,
      posts: {
        select: { title: true, tag: { select: { ownerModel: true } } },
        where: { tag: { ownerModel: { equals: 'platform' } } },
      },
    });
  });

  test('the root grant columns are selected; the root where is the query where', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id'], where: { field: 'org.plan', operator: 'equals', value: 'pro' } },
    };
    expect(toLensSelect(lens).select).toEqual({ id: true, org: { select: { plan: true } } });
  });

  test('a relation that shows no column is fetched whole: Prisma selects nothing never', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['posts'], relations: { posts: { picks: [] } } },
    };
    expect(toLensSelect(lens).select).toEqual({ posts: true });
  });

  test('a relation grant that needs a counting step throws', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['posts'],
        relations: {
          posts: {
            picks: ['id'],
            where: { field: 'comments', arrayOperator: 'atLeast', count: 2, condition: true },
          },
        },
      },
    };
    expect(() => toLensSelect(lens)).toThrow(/counting step/);
  });

  test('the clock is an input: a relative date grant compiles with `now`', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['posts'],
        relations: {
          posts: {
            picks: ['id'],
            where: { field: 'deletedAt', dateOperator: 'after', value: { ago: { days: 1 } } },
          },
        },
      },
    };
    expect(() => toLensSelect(lens)).toThrow();
    const { select } = toLensSelect(lens, { now: new Date('2026-10-07T00:00:00Z') });
    expect((select.posts as { where: unknown }).where).toBeDefined();
  });
});

describe('projectRows', () => {
  test('keeps only the visible columns', () => {
    const lens: LensNarrowing = { parent: base, root: { picks: ['id', 'name'] } };
    expect(
      projectRows(lens, [
        { id: 'u1', name: 'Ann', email: 'a@x' },
        { id: 'u2', name: 'Bob', status: 'x' },
      ]),
    ).toEqual([
      { id: 'u1', name: 'Ann' },
      { id: 'u2', name: 'Bob' },
    ]);
  });

  test("keepGrantColumns keeps the columns a visit's where reads, hidden or not", () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'org'],
        relations: { org: { picks: ['id'], where: live } },
      },
      mapDefaults: {
        prisma: {
          models: { User: { where: { field: 'status', operator: 'equals', value: 'on' } } },
        },
      },
    };
    const row = {
      id: 'u1',
      status: 'on',
      name: 'x',
      org: { id: 'o1', name: 'Acme', deletedAt: null },
    };
    expect(projectRows(lens, [row], { keepGrantColumns: true })).toEqual([
      { id: 'u1', status: 'on', org: { id: 'o1', deletedAt: null } },
    ]);
    expect(projectRows(lens, [row])).toEqual([{ id: 'u1', org: { id: 'o1' } }]);
  });

  test("keeps a grant's dotted read exactly, under a relation it hides", () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'org'],
        relations: { org: { picks: ['id'] } },
        where: { field: 'org.plan', operator: 'equals', value: 'pro' },
      },
    };
    const row = { id: 'u1', org: { id: 'o1', name: 'Acme', plan: 'pro' } };
    expect(projectRows(lens, [row], { keepGrantColumns: true })).toEqual([
      { id: 'u1', org: { id: 'o1', plan: 'pro' } },
    ]);
  });

  test("drops the related rows a visit's where hides: a list element goes, a to-one becomes null", () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'posts'],
        relations: {
          posts: {
            picks: [],
            where: live,
            relations: {
              tag: {
                picks: ['id', 'name'],
                where: { field: 'ownerModel', operator: 'equals', value: 'platform' },
              },
            },
          },
        },
      },
    };
    const row = {
      id: 'u1',
      posts: [
        { deletedAt: null, tag: { id: 'mine', name: 'vip', ownerModel: 'platform' } },
        { deletedAt: null, tag: { id: 'theirs', name: 'vip', ownerModel: 'Organization' } },
        { deletedAt: '2026-01-01', tag: { id: 'gone', name: 'vip', ownerModel: 'platform' } },
      ],
    };
    expect(projectRows(lens, [row], { keepGrantColumns: true })).toEqual([
      {
        id: 'u1',
        posts: [
          { deletedAt: null, tag: { id: 'mine', name: 'vip', ownerModel: 'platform' } },
          { deletedAt: null, tag: null },
        ],
      },
    ]);
  });

  test("a root row the root's where hides is dropped", () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id', 'name'], where: { field: 'id', operator: 'equals', value: 'u1' } },
    };
    expect(
      projectRows(lens, [
        { id: 'u1', name: 'Ann', email: 'x' },
        { id: 'u2', name: 'FOREIGN' },
      ]),
    ).toEqual([{ id: 'u1', name: 'Ann' }]);
  });

  test('stacked layers: a projection, a model default scope and a target each decide', () => {
    const projection: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'name', 'posts'],
        relations: {
          posts: { picks: [], where: live, relations: { tag: { picks: ['id', 'name'] } } },
        },
      },
    };
    const scoped: LensNarrowing = {
      parent: projection,
      mapDefaults: {
        prisma: {
          models: {
            Tag: { where: { field: 'ownerModel', operator: 'equals', value: 'platform' } },
          },
        },
      },
    };
    const targeted: LensNarrowing = {
      parent: scoped,
      root: { where: { field: 'id', operator: 'equals', value: 'u1' } },
    };
    const post = (deletedAt: string | null, ownerModel: string) => ({
      deletedAt,
      tag: { id: 't', name: 'vip', ownerModel },
    });
    const rows = [
      {
        id: 'u1',
        name: 'Ann',
        posts: [post(null, 'platform'), post(null, 'Org'), post('x', 'platform')],
      },
      { id: 'u2', name: 'Bob', posts: [post(null, 'platform')] },
    ];
    expect(projectRows(targeted, rows)).toEqual([
      { id: 'u1', name: 'Ann', posts: [{ tag: { id: 't', name: 'vip' } }, { tag: null }] },
    ]);
  });

  test('a visible relation off the declared paths is cut to its visible columns and admitted', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id', 'org'] },
      mapDefaults: { prisma: { models: { Org: { omits: ['plan'], where: live } } } },
    };
    expect(
      projectRows(lens, [
        { id: 'u1', org: { id: 'o1', name: 'A', plan: 'pro', deletedAt: null } },
        { id: 'u2', org: { id: 'o2', name: 'B', plan: 'pro', deletedAt: '2026-01-01' } },
      ]),
    ).toEqual([
      { id: 'u1', org: { id: 'o1', name: 'A', deletedAt: null } },
      { id: 'u2', org: null },
    ]);
  });

  test('own properties only, and the input is not mutated', () => {
    const lens: LensNarrowing = { parent: base, root: { picks: ['id', 'name'] } };
    const row = Object.freeze({ id: 'u1' });
    expect(projectRows(lens, [row])).toEqual([{ id: 'u1' }]);
  });
});
