import { describe, expect, test } from 'bun:test';
import { projectNarrowing } from '../src/lens/project';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

// mapDefaults: applies-everywhere narrowings, intrinsic to a model or enum
// type. Must compose with path-specific `root` via intersection, and stack
// across chained narrowings.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        password: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', isList: false },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('mapDefaults — applies-everywhere model narrowings', () => {
  test('mapDefaults.prisma.models.User.omits=[password] strips password at root visit', () => {
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.models.User.fields.password).toBeUndefined();
    expect(out.maps.prisma.models.User.fields.email).toBeDefined();
  });

  test('mapDefaults strips password at NESTED visit too (Post.author → User)', () => {
    // Critical: defaults apply wherever the model appears, not just root.
    const n = withParent(lens, {
      root: {
        relations: {
          posts: {
            relations: { author: {} }, // descend into Post.author (User again)
          },
        },
      },
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    const out = projectNarrowing(n);
    // The User model is shared in the projected map. Defaults applies to it.
    expect(out.maps.prisma.models.User.fields.password).toBeUndefined();
  });

  test('mapDefaults chains across narrowings (b drops more than a, both apply)', () => {
    const a = withParent(lens, {
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    const b = withParent(a, {
      mapDefaults: { prisma: { models: { User: { omits: ['email'] } } } },
    });
    const out = projectNarrowing(b);
    expect(out.maps.prisma.models.User.fields.password).toBeUndefined();
    expect(out.maps.prisma.models.User.fields.email).toBeUndefined();
    expect(out.maps.prisma.models.User.fields.id).toBeDefined();
  });

  test('mapDefaults intersects with path-specific picks (intersection-only)', () => {
    // defaults picks ['id','email'], path picks ['email','password']
    // intersection: ['email']
    const n = withParent(lens, {
      root: { picks: ['email', 'password'] },
      mapDefaults: { prisma: { models: { User: { picks: ['id', 'email'] } } } },
    });
    const out = projectNarrowing(n);
    const fields = Object.keys(out.maps.prisma.models.User.fields).sort();
    expect(fields).toEqual(['email']);
  });
});

describe('mapDefaults.enums — applies-everywhere enum narrowing', () => {
  const mapWithEnums: FieldMap = {
    ...map,
    enums: { UserRole: ['admin', 'member', 'owner', 'guest'] },
  };
  const lensE: Lens = { maps: { prisma: mapWithEnums }, mapName: 'prisma', model: 'User' };

  test('mapDefaults.prisma.enums.UserRole.omits=[owner] narrows the registry', () => {
    const n = withParent(lensE, {
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.enums?.UserRole).toEqual(['admin', 'member', 'guest']);
  });

  test('mapDefaults.enums chains across narrowings (intersection)', () => {
    const a = withParent(lensE, {
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const b = withParent(a, {
      mapDefaults: { prisma: { enums: { UserRole: { picks: ['admin', 'member'] } } } },
    });
    const out = projectNarrowing(b);
    expect([...(out.maps.prisma.enums?.UserRole ?? [])].sort()).toEqual(['admin', 'member']);
  });
});
