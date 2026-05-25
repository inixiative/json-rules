import { describe, expect, test } from 'bun:test';
import { projectNarrowing } from '../src/lens/project';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';
import { multiRelMap } from './fixtures/multiRelMap';

// v2.3 fix: projectNarrowing previously keyed accumulators by `${map}::${model}`,
// which collapsed two sibling relation paths pointing at the SAME model into one
// accumulator → their picks intersected → often empty. Per-visit semantics
// (resolveVisit / checkRuleAgainstLens / applyLens) were already path-correct,
// but projection wasn't.
//
// Fix: walk path-specific narrowings keyed by `${map}::${dottedPath}` so each
// path's restrictions stay isolated. To produce the flat FieldMapSet output,
// take the UNION across sibling paths (a field is visible in the projection if
// visible at SOME path) and then INTERSECT with mapDefaults (applies-everywhere
// constraints still bite).

const lens: Lens = { maps: { prisma: multiRelMap }, mapName: 'prisma', model: 'Post' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('v2.3 projectNarrowing — sibling paths to same model do not collapse', () => {
  test('two sibling relations to User with disjoint picks: union, not intersection', () => {
    // Post.author -> User (picks 'name')
    // Post.editor -> User (picks 'id')  — intentionally disjoint
    // Pre-2.3 BUG: both write to `prisma::User` acc → intersection = ∅ → User has nothing.
    // 2.3: union = {name, id} → User exposes both.
    const n = withParent(lens, {
      root: {
        relations: {
          author: { picks: ['name'] },
          editor: { picks: ['id'] },
        },
      },
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.models.User.fields.name).toBeDefined();
    expect(out.maps.prisma.models.User.fields.id).toBeDefined();
    // Fields not picked at any path are dropped.
    expect(out.maps.prisma.models.User.fields.authoredPosts).toBeUndefined();
    expect(out.maps.prisma.models.User.fields.editedPosts).toBeUndefined();
  });

  test('sibling picks union, then mapDefaults intersection still bites', () => {
    // author picks {name, id}; editor picks {id} → union {name, id}
    // mapDefaults says User omits ['name'] → final projection: User has just 'id'
    const n = withParent(lens, {
      root: {
        relations: {
          author: { picks: ['name', 'id'] },
          editor: { picks: ['id'] },
        },
      },
      mapDefaults: { prisma: { models: { User: { omits: ['name'] } } } },
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.models.User.fields.id).toBeDefined();
    expect(out.maps.prisma.models.User.fields.name).toBeUndefined();
  });

  test('one sibling path narrows, the other has no narrowing → union = all fields', () => {
    // author: no picks (no restriction at this path)
    // editor: picks ['id']
    // Union across paths: all fields (because author path allows everything).
    const n = withParent(lens, {
      root: {
        relations: {
          author: {}, // no restriction — all fields visible via this path
          editor: { picks: ['id'] },
        },
      },
    });
    const out = projectNarrowing(n);
    // All User fields stay visible (because reachable via author with no restriction).
    expect(out.maps.prisma.models.User.fields.id).toBeDefined();
    expect(out.maps.prisma.models.User.fields.name).toBeDefined();
    expect(out.maps.prisma.models.User.fields.authoredPosts).toBeDefined();
    expect(out.maps.prisma.models.User.fields.editedPosts).toBeDefined();
  });

  test('chain composition WITHIN a path still intersects (monotonic restriction)', () => {
    // Layer 1 picks {name, id} at editor; Layer 2 picks {id} at editor.
    // Within the editor path: intersection = {id}.
    // sourceUser (author) path: picks {name}.
    // Union across paths: {id, name}.
    const n1 = withParent(lens, {
      root: {
        relations: {
          author: { picks: ['name'] },
          editor: { picks: ['name', 'id'] },
        },
      },
    });
    const n2 = withParent(n1, {
      root: {
        relations: {
          editor: { picks: ['id'] }, // narrows editor path further
        },
      },
    });
    const out = projectNarrowing(n2);
    expect(out.maps.prisma.models.User.fields.id).toBeDefined();
    expect(out.maps.prisma.models.User.fields.name).toBeDefined();
  });
});

// Recursive same-model in ONE path — the SpaceUser case from v2_1.pathAware.
// Each visit on the same path is an independent path key after this fix.
const recursiveMap: FieldMap = {
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
const recLens: Lens = { maps: { prisma: recursiveMap }, mapName: 'prisma', model: 'User' };

describe('v2.3 projectNarrowing — same model recurring in ONE path', () => {
  test('two visits to SpaceUser on the same path each contribute independently to the union', () => {
    // visit-1 SpaceUser: picks ['spaceId', 'user']
    // visit-2 SpaceUser: picks ['orgId', 'role']
    // Pre-2.3 BUG: both keyed by `prisma::SpaceUser` → intersection = ∅.
    // 2.3: each visit is its own path key → union = {spaceId, user, orgId, role}.
    const n = withParent(recLens, {
      root: {
        relations: {
          spaceUsers: {
            picks: ['spaceId', 'user'],
            relations: {
              user: {
                picks: ['spaceUsers'],
                relations: {
                  spaceUsers: { picks: ['orgId', 'role'] },
                },
              },
            },
          },
        },
      },
    });
    const out = projectNarrowing(n);
    const su = out.maps.prisma.models.SpaceUser.fields;
    expect(su.spaceId).toBeDefined();
    expect(su.user).toBeDefined();
    expect(su.orgId).toBeDefined();
    expect(su.role).toBeDefined();
    // id was never picked at any visit → dropped
    expect(su.id).toBeUndefined();
  });
});
