import { describe, expect, test } from 'bun:test';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

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
    const out = projectByPath(n);
    const root = out.get('User')!;
    expect(root.fields.password).toBeUndefined();
    expect(root.fields.email).toBeDefined();
  });

  test('mapDefaults strips password at NESTED visit too (User.posts.author → User)', () => {
    const n = withParent(lens, {
      root: {
        relations: {
          posts: {
            relations: { author: {} },
          },
        },
      },
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    const out = projectByPath(n);
    expect(out.get('User')!.fields.password).toBeUndefined();
    expect(out.get('User.posts.author')!.fields.password).toBeUndefined();
  });

  test('mapDefaults chains across narrowings (b drops more than a, both apply)', () => {
    const a = withParent(lens, {
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    const b = withParent(a, {
      mapDefaults: { prisma: { models: { User: { omits: ['email'] } } } },
    });
    const root = projectByPath(b).get('User')!;
    expect(root.fields.password).toBeUndefined();
    expect(root.fields.email).toBeUndefined();
    expect(root.fields.id).toBeDefined();
  });

  test('mapDefaults intersects with path-specific picks (intersection-only)', () => {
    const n = withParent(lens, {
      root: { picks: ['email', 'password'] },
      mapDefaults: { prisma: { models: { User: { picks: ['id', 'email'] } } } },
    });
    expect(Object.keys(projectByPath(n).get('User')!.fields).sort()).toEqual(['email']);
  });
});

describe('mapDefaults.enums — applies-everywhere enum narrowing', () => {
  const mapWithEnums: FieldMap = {
    ...map,
    enums: { UserRole: ['admin', 'member', 'owner', 'guest'] },
  };
  const lensE: Lens = { maps: { prisma: mapWithEnums }, mapName: 'prisma', model: 'User' };

  test('mapDefaults.prisma.enums.UserRole.omits=[owner] narrows allowed values on the role field', () => {
    const n = withParent(lensE, {
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const role = projectByPath(n).get('User')!.fields.role;
    expect([...(role.values ?? [])].sort()).toEqual(['admin', 'guest', 'member']);
  });

  test('mapDefaults.enums chains across narrowings (intersection)', () => {
    const a = withParent(lensE, {
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const b = withParent(a, {
      mapDefaults: { prisma: { enums: { UserRole: { picks: ['admin', 'member'] } } } },
    });
    const role = projectByPath(b).get('User')!.fields.role;
    expect([...(role.values ?? [])].sort()).toEqual(['admin', 'member']);
  });
});
