import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// P1.1 from Codex review: same model reached via different paths can have
// different narrowings declared. The pre-2.1 projectNarrowing collapses
// these into a single User shape, and validation against the projected set
// loses the distinction. checkRuleAgainstLens must walk the narrowing tree
// alongside the user rule and apply path-specific narrowings per visit.

const map: FieldMap = {
  models: {
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        body: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', isList: false },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', isList: false },
        comments: { kind: 'object', type: 'Comment', isList: true },
      },
    },
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        password: { kind: 'scalar', type: 'String' },
        manager: { kind: 'object', type: 'User', isList: false },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('checkRuleAgainstLens — path-aware (same model, different narrowings per path)', () => {
  test('User.manager.email allowed, Post.author.email rejected (different narrowings, same model)', () => {
    // User narrowing tree:
    //   .manager → User, picks ['email', 'name']
    //   .posts → Post → .author → User, picks ['name']  (no email visible via posts.author)
    const n = withParent(lens, {
      root: {
        picks: ['id', 'manager', 'posts'],
        relations: {
          manager: { picks: ['email', 'name'] },
          posts: {
            picks: ['author'],
            relations: {
              author: { picks: ['name'] }, // intentionally no email
            },
          },
        },
      },
    });

    // Rule via .manager.email → allowed
    expect(
      checkRuleAgainstLens({ field: 'manager.email', operator: Operator.equals, value: 'x' }, n).ok,
    ).toBe(true);

    // Rule via .posts.author.email → rejected (email not in this path's narrowing)
    const bad = checkRuleAgainstLens(
      { field: 'posts.author.email', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(bad.ok).toBe(false);
    expect(bad.violations[0].path).toBe('posts.author.email');
  });

  test('Two paths each declare User narrowing; rule must use the right field per path', () => {
    const n = withParent(lens, {
      root: {
        picks: ['manager', 'posts'],
        relations: {
          manager: { picks: ['email'] }, // only email visible via .manager
          posts: {
            picks: ['author'],
            relations: {
              author: { picks: ['name'] }, // only name visible via .posts.author
            },
          },
        },
      },
    });
    expect(
      checkRuleAgainstLens({ field: 'manager.email', operator: Operator.equals, value: 'x' }, n).ok,
    ).toBe(true);
    expect(
      checkRuleAgainstLens({ field: 'manager.name', operator: Operator.equals, value: 'x' }, n).ok,
    ).toBe(false);
    expect(
      checkRuleAgainstLens({ field: 'posts.author.name', operator: Operator.equals, value: 'x' }, n)
        .ok,
    ).toBe(true);
    expect(
      checkRuleAgainstLens(
        { field: 'posts.author.email', operator: Operator.equals, value: 'x' },
        n,
      ).ok,
    ).toBe(false);
  });

  // Realistic recursive schema: a SpaceUser junction has spaceId/orgId/user.
  // The path User → spaceUsers (their memberships) → user (themselves again) → spaceUsers
  // (their OTHER memberships, e.g. scoped to a different org) visits SpaceUser twice on one
  // descent path. Each visit's narrowing is independent.
  const realMap: FieldMap = {
    models: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          email: { kind: 'scalar', type: 'String' },
          spaceUsers: { kind: 'object', type: 'SpaceUser', isList: true },
        },
      },
      SpaceUser: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          spaceId: { kind: 'scalar', type: 'String' },
          orgId: { kind: 'scalar', type: 'String' },
          role: { kind: 'scalar', type: 'String' },
          user: { kind: 'object', type: 'User', isList: false },
        },
      },
    },
  };
  const realLens: Lens = {
    maps: { prisma: realMap },
    mapName: 'prisma',
    model: 'User',
  };

  test('same model recurring in ONE path: picks/omits at each visit are independent', () => {
    // visit-1 SpaceUser: see spaceId + user (for descent)
    // visit-2 SpaceUser: see orgId + role
    const n = withParent(realLens, {
      root: {
        relations: {
          spaceUsers: {
            picks: ['spaceId', 'user'],
            relations: {
              user: {
                picks: ['spaceUsers'],
                relations: {
                  spaceUsers: {
                    picks: ['orgId', 'role'], // visit-2 picks are independent of visit-1
                  },
                },
              },
            },
          },
        },
      },
    });

    // visit-1: spaceId visible
    expect(
      checkRuleAgainstLens(
        { field: 'spaceUsers.spaceId', operator: Operator.equals, value: 'space-1' },
        n,
      ).ok,
    ).toBe(true);
    // visit-1: orgId NOT visible
    expect(
      checkRuleAgainstLens(
        { field: 'spaceUsers.orgId', operator: Operator.equals, value: 'org-1' },
        n,
      ).ok,
    ).toBe(false);
    // visit-2: orgId IS visible (independent of visit-1)
    expect(
      checkRuleAgainstLens(
        { field: 'spaceUsers.user.spaceUsers.orgId', operator: Operator.equals, value: 'org-1' },
        n,
      ).ok,
    ).toBe(true);
    // visit-2: spaceId NOT visible (visit-1's having it is irrelevant here)
    expect(
      checkRuleAgainstLens(
        { field: 'spaceUsers.user.spaceUsers.spaceId', operator: Operator.equals, value: 'x' },
        n,
      ).ok,
    ).toBe(false);
  });

  test('same model recurring in ONE path: where clauses at each visit are independent', () => {
    // visit-1 SpaceUser: scope to spaceId = 'space-1'
    // visit-2 SpaceUser: scope to orgId = 'org-1'
    // Each where applies only at its own visit.
    const n = withParent(realLens, {
      root: {
        relations: {
          spaceUsers: {
            where: { field: 'spaceId', operator: Operator.equals, value: 'space-1' },
            relations: {
              user: {
                relations: {
                  spaceUsers: {
                    where: { field: 'orgId', operator: Operator.equals, value: 'org-1' },
                  },
                },
              },
            },
          },
        },
      },
    });

    // applyLens should produce a rule where visit-1's where lives at the visit-1 anchor
    // and visit-2's where lives at the visit-2 anchor — not collapsed.
    const userRule: Condition = {
      field: 'spaceUsers',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'user',
        operator: Operator.exists,
      },
    };
    const composed = applyLens(userRule, n) as {
      condition: { all: Condition[] };
    };
    // visit-1's where is ANDed into the spaceUsers arrayRule condition
    const innerAll = composed.condition.all;
    expect(innerAll).toContainEqual({
      field: 'spaceId',
      operator: Operator.equals,
      value: 'space-1',
    });
    // visit-2's where doesn't appear here — it would only fire if the rule descended via
    // .user.spaceUsers, which this rule doesn't. Confirming visit-1 isn't a stand-in for visit-2.
    expect(innerAll).not.toContainEqual({
      field: 'orgId',
      operator: Operator.equals,
      value: 'org-1',
    });
  });

  test('mapDefaults.models[SpaceUser] applies at BOTH SpaceUser visits in the recursive path', () => {
    const n = withParent(realLens, {
      root: {
        relations: {
          spaceUsers: {
            relations: { user: { relations: { spaceUsers: {} } } },
          },
        },
      },
      mapDefaults: { prisma: { models: { SpaceUser: { omits: ['role'] } } } },
    });

    // role blocked at visit-1
    expect(
      checkRuleAgainstLens(
        { field: 'spaceUsers.role', operator: Operator.equals, value: 'admin' },
        n,
      ).ok,
    ).toBe(false);
    // role blocked at visit-2 too — defaults apply at every visit of SpaceUser
    expect(
      checkRuleAgainstLens(
        { field: 'spaceUsers.user.spaceUsers.role', operator: Operator.equals, value: 'admin' },
        n,
      ).ok,
    ).toBe(false);
  });

  test('mapDefaults.models.User applies at every User visit AND intersects with per-path narrowings', () => {
    // defaults: password never visible anywhere
    // manager: picks email/password (but password excluded by defaults → effective just email)
    // posts.author: picks email
    const n = withParent(lens, {
      root: {
        picks: ['manager', 'posts'],
        relations: {
          // NOTE: cannot pick password if defaults excludes it — strict validation
          // applies. So we just pick email here.
          manager: { picks: ['email'] },
          posts: {
            picks: ['author'],
            relations: { author: { picks: ['email'] } },
          },
        },
      },
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });

    expect(
      checkRuleAgainstLens({ field: 'manager.password', operator: Operator.equals, value: 'x' }, n)
        .ok,
    ).toBe(false);
    expect(
      checkRuleAgainstLens(
        { field: 'posts.author.password', operator: Operator.equals, value: 'x' },
        n,
      ).ok,
    ).toBe(false);
    // email IS visible via both paths
    expect(
      checkRuleAgainstLens({ field: 'manager.email', operator: Operator.equals, value: 'x' }, n).ok,
    ).toBe(true);
    expect(
      checkRuleAgainstLens(
        { field: 'posts.author.email', operator: Operator.equals, value: 'x' },
        n,
      ).ok,
    ).toBe(true);
  });
});
