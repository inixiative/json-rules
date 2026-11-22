import { beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  check,
  conditionForRootRowsWithRelatedRows,
  createLens,
  executePrismaPlan,
  type LensNarrowing,
  narrowRule,
  toPrismaForRootRowsWithRelatedRows,
} from '../index';
import { map, openRails } from './rails/harness';

// Real Prisma 7 + PGlite execution of `toPrismaForRootRowsWithRelatedRows` vs `check()` across
// 1-, 2-, and 3-hop paths, self-relations, hidden join keys, root clamps, and intermediate clamps.
//
// Seeded graph in `test/rails/harness.ts`:
//   Orgs:  10 (Acme, pro, parent=null) ← 11 (acme, parent=10) ← 12 (free, parent=11)
//   Users: 1 (Ann, age 30, org=10), 2 (bob, age null, org=11), 3 (age 5, org=12),
//          4 (Dee, age 40, org=null), 5 (nullable, age 7, org=null)
//   Posts: 100,101,103 (author=1), 102 (author=3)

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});

const userBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const orgBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Org' });
const postBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Post' });

const userIds = async (
  plan: ReturnType<typeof toPrismaForRootRowsWithRelatedRows>,
): Promise<number[]> => {
  if (!plan) return [];
  const where = await executePrismaPlan(plan, rails.prisma as never);
  const found = await rails.prisma.user.findMany({
    where: where as never,
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return found.map((row) => row.id);
};

const orgIds = async (
  plan: ReturnType<typeof toPrismaForRootRowsWithRelatedRows>,
): Promise<number[]> => {
  if (!plan) return [];
  const where = await executePrismaPlan(plan, rails.prisma as never);
  const found = await rails.prisma.org.findMany({
    where: where as never,
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return found.map((row) => row.id);
};

const postIds = async (
  plan: ReturnType<typeof toPrismaForRootRowsWithRelatedRows>,
): Promise<number[]> => {
  if (!plan) return [];
  const where = await executePrismaPlan(plan, rails.prisma as never);
  const found = await rails.prisma.post.findMany({
    where: where as never,
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return found.map((row) => row.id);
};

describe('rails: toPrismaForRootRowsWithRelatedRows against PGlite', () => {
  test('1-hop to-many (User -> posts) and 1-hop to-one (User -> org) with hidden join keys', async () => {
    const lens: LensNarrowing = {
      parent: userBase,
      root: {
        picks: ['name'], // hides `id` and `orgId`
        relations: { posts: { picks: ['title'] }, org: { picks: ['name'] } },
      },
    };

    // Deleted/changed Post row (even a synthetic post not in DB) resolves via authorId.
    const fromPost = toPrismaForRootRowsWithRelatedRows(lens, {
      path: 'posts',
      rows: [
        { id: 999, authorId: 1 },
        { id: 102, authorId: 3 },
      ],
    });
    expect(await userIds(fromPost)).toEqual([1, 3]);

    const fromOrg = toPrismaForRootRowsWithRelatedRows(lens, {
      path: 'org',
      rows: [{ id: 10 }, { id: 12 }],
    });
    expect(await userIds(fromOrg)).toEqual([1, 3]);

    // Agrees with in-memory check() over the loaded rows.
    const cond = conditionForRootRowsWithRelatedRows(lens, 'org', [
      { id: 10 },
      { id: 12 },
    ]) as Condition;
    expect(rails.rows.filter((row) => check(cond, row) === true).map((row) => row.id)).toEqual([
      1, 3,
    ]);
  });

  test('2-hop to-one self-relation (User -> org -> parent) and multi-target OR', async () => {
    const lens: LensNarrowing = {
      parent: userBase,
      root: {
        picks: ['name'],
        relations: { org: { picks: ['name'], relations: { parent: { picks: ['name'] } } } },
      },
    };

    // Org 10 is parent of Org 11, which holds User 2.
    const parentOnly = toPrismaForRootRowsWithRelatedRows(lens, {
      path: 'org.parent',
      rows: [{ id: 10 }],
    });
    expect(await userIds(parentOnly)).toEqual([2]);

    // Org 10 directly (User 1) OR as org.parent (User 2) in one query.
    const both = toPrismaForRootRowsWithRelatedRows(lens, [
      { path: 'org', rows: [{ id: 10 }] },
      { path: 'org.parent', rows: [{ id: 10 }] },
    ]);
    expect(await userIds(both)).toEqual([1, 2]);
  });

  test('2-hop to-many -> to-many (Org -> users -> posts) and 3-hop (Org -> children -> users -> posts)', async () => {
    const lens: LensNarrowing = {
      parent: orgBase,
      root: {
        picks: ['name'],
        relations: {
          users: { picks: ['name'], relations: { posts: { picks: ['title'] } } },
          children: {
            picks: ['name'],
            relations: { users: { picks: ['name'], relations: { posts: { picks: ['title'] } } } },
          },
        },
      },
    };

    // Post 102 belongs to User 3 → Org 12 → parent Org 11.
    const twoHop = toPrismaForRootRowsWithRelatedRows(lens, {
      path: 'users.posts',
      rows: [{ id: 102, authorId: 3 }],
    });
    expect(await orgIds(twoHop)).toEqual([12]);

    const threeHop = toPrismaForRootRowsWithRelatedRows(lens, {
      path: 'children.users.posts',
      rows: [{ id: 102, authorId: 3 }],
    });
    expect(await orgIds(threeHop)).toEqual([11]);
  });

  test('3-hop to-one chain (Post -> author -> org -> parent)', async () => {
    const lens: LensNarrowing = {
      parent: postBase,
      root: {
        picks: ['title'],
        relations: {
          author: {
            picks: ['name'],
            relations: { org: { picks: ['name'], relations: { parent: { picks: ['name'] } } } },
          },
        },
      },
    };

    // Org 11 is parent of Org 12 → User 3 → Post 102.
    const plan = toPrismaForRootRowsWithRelatedRows(lens, {
      path: 'author.org.parent',
      rows: [{ id: 11 }],
    });
    expect(await postIds(plan)).toEqual([102]);
  });

  test('always obeys the lens stack (root and intermediate clamps); pass a shallower layer for fewer clamps', async () => {
    // Layer 1: root clamp excludes Org 12 (plan != 'free'), no intermediate user clamp.
    const orgRootLens: LensNarrowing = {
      parent: orgBase,
      root: {
        picks: ['name'],
        where: { field: 'plan', operator: 'notEquals', value: 'free' },
        relations: {
          children: {
            picks: ['name'],
            relations: {
              users: { picks: ['name', 'age'], relations: { posts: { picks: ['title'] } } },
            },
          },
          users: { picks: ['name', 'age'], relations: { posts: { picks: ['title'] } } },
        },
      },
    };

    // Layer 2: narrows `users` to adults (age >= 20, excluding User 3 whose age is 5).
    const adultUsersOrgLens: LensNarrowing = {
      parent: orgRootLens,
      root: {
        relations: {
          children: {
            relations: {
              users: { where: { field: 'age', operator: 'greaterThanEquals', value: 20 } },
            },
          },
          users: { where: { field: 'age', operator: 'greaterThanEquals', value: 20 } },
        },
      },
    };

    // Post 102 has author User 3 (age 5, in Org 12 [free], child of Org 11 [plan=null]).
    // 1. On `users.posts`: Org 12 is excluded by root.where (plan != 'free') on both layers.
    expect(
      await orgIds(
        toPrismaForRootRowsWithRelatedRows(orgRootLens, {
          path: 'users.posts',
          rows: [{ id: 102, authorId: 3 }],
        }),
      ),
    ).toEqual([]);

    // 2. On `children.users.posts`: Org 11 passes root.where, while intermediate User 3 has age 5:
    //    - Shallower layer (orgRootLens) finds Org 11.
    //    - Deeper layer (adultUsersOrgLens) obeys its `users.where` clamp and returns [].
    expect(
      await orgIds(
        toPrismaForRootRowsWithRelatedRows(orgRootLens, {
          path: 'children.users.posts',
          rows: [{ id: 102, authorId: 3 }],
        }),
      ),
    ).toEqual([11]);
    expect(
      await orgIds(
        toPrismaForRootRowsWithRelatedRows(adultUsersOrgLens, {
          path: 'children.users.posts',
          rows: [{ id: 102, authorId: 3 }],
        }),
      ),
    ).toEqual([]);

    // 3. Agrees with check(narrowRule(cond, lens)) on User -> org.parent across both layers.
    const userRootLens: LensNarrowing = {
      parent: userBase,
      root: {
        picks: ['name'],
        where: { field: 'age', operator: 'greaterThanEquals', value: 1 },
        relations: {
          org: { picks: ['name', 'plan'], relations: { parent: { picks: ['name'] } } },
        },
      },
    };
    const proOrgUserLens: LensNarrowing = {
      parent: userRootLens,
      root: {
        relations: {
          org: { where: { field: 'plan', operator: 'equals', value: 'pro' } },
        },
      },
    };

    for (const [lens, expected] of [
      [userRootLens, [3]],
      [proOrgUserLens, []], // User 3's org 12 has plan='free', not 'pro'
    ] as const) {
      const cond = conditionForRootRowsWithRelatedRows(lens, 'org.parent', [
        { id: 11 },
      ]) as Condition;
      const checked = rails.rows
        .filter((row) => check(narrowRule(cond, lens), row) === true)
        .map((row) => row.id);
      const compiled = await userIds(
        toPrismaForRootRowsWithRelatedRows(lens, { path: 'org.parent', rows: [{ id: 11 }] }),
      );
      expect(compiled).toEqual(checked);
      expect(compiled).toEqual([...expected]);
    }
  });
});
