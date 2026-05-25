import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

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

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

describe('checkRuleAgainstLens — path-aware (same model, different narrowings per path)', () => {
  test('User.manager.email allowed, Post.author.email rejected (different narrowings, same model)', () => {
    // User narrowing tree:
    //   .manager → User, picks ['email', 'name']
    //   .posts → Post → .author → User, picks ['name']  (no email visible via posts.author)
    const n = withParent(lens, {
      prisma: {
        models: {
          User: {
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
      prisma: {
        models: {
          User: {
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

  test('defaults.models.User applies at every User visit AND intersects with per-path narrowings', () => {
    // defaults: password never visible anywhere
    // manager: picks email/password (but password excluded by defaults → effective just email)
    // posts.author: picks email
    const n = withParent(lens, {
      prisma: {
        models: {
          User: {
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
        },
        defaults: { models: { User: { omits: ['password'] } } },
      },
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
