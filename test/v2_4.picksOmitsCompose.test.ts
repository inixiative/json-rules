import { describe, expect, test } from 'bun:test';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  models: {
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        secret: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', isList: false },
      },
    },
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        password: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'Post' };

const withParent = (parent: Lens | LensNarrowing, rest: Omit<LensNarrowing, 'parent'>) => ({
  parent,
  ...rest,
});

const fieldsAt = (l: Lens | LensNarrowing, path: string): string[] =>
  Object.keys(projectByPath(l).get(path)?.fields ?? {}).sort();

describe('projectByPath — picks/omits composition', () => {
  test('pure picks at root', () => {
    expect(fieldsAt(withParent(lens, { root: { picks: ['title'] } }), 'Post')).toEqual(['title']);
  });

  test('pure omits at root (no picks anywhere → everything else visible)', () => {
    expect(fieldsAt(withParent(lens, { root: { omits: ['secret'] } }), 'Post')).toEqual([
      'author',
      'id',
      'title',
    ]);
  });

  test('picks across chain layers intersect', () => {
    const n1 = withParent(lens, { root: { picks: ['id', 'title', 'secret'] } });
    const n2 = withParent(n1, { root: { picks: ['id', 'title'] } });
    expect(fieldsAt(n2, 'Post')).toEqual(['id', 'title']);
  });

  test('omits across chain layers union', () => {
    const n1 = withParent(lens, { root: { omits: ['secret'] } });
    const n2 = withParent(n1, { root: { omits: ['title'] } });
    expect(fieldsAt(n2, 'Post')).toEqual(['author', 'id']);
  });

  test('path picks + mapDefaults omits compose (omits subtract from picks)', () => {
    const n = withParent(lens, {
      root: { relations: { author: { picks: ['name', 'email', 'password'] } } },
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    expect(fieldsAt(n, 'Post.author')).toEqual(['email', 'name']);
  });

  test('mapDefaults picks + path picks intersect', () => {
    const n = withParent(lens, {
      root: { relations: { author: { picks: ['id', 'name'] } } },
      mapDefaults: { prisma: { models: { User: { picks: ['name', 'email'] } } } },
    });
    expect(fieldsAt(n, 'Post.author')).toEqual(['name']);
  });

  test('mapDefaults picks + path omits compose (omits subtract from defaults picks)', () => {
    const n = withParent(lens, {
      root: { relations: { author: { omits: ['email'] } } },
      mapDefaults: { prisma: { models: { User: { picks: ['name', 'email', 'id'] } } } },
    });
    expect(fieldsAt(n, 'Post.author')).toEqual(['id', 'name']);
  });

  test('omit beats pick at the same conceptual visit (defaults omits + path picks of same field)', () => {
    // Unvalidated path picks something defaults omits → omit wins (fail-safe).
    // (validateNarrowing would reject this at construction; runtime fails closed.)
    const n = withParent(lens, {
      root: { relations: { author: { picks: ['name', 'password'] } } },
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    });
    expect(fieldsAt(n, 'Post.author')).toEqual(['name']);
  });

  test('picks at root + relations declared but no nested picks (relation auto-added to picks)', () => {
    const n = withParent(lens, {
      root: {
        picks: ['title'],
        relations: { author: {} },
      },
    });
    // `author` auto-added to picks via augmentPicksWithRelations
    expect(fieldsAt(n, 'Post')).toEqual(['author', 'title']);
    // Nested visit has no narrowing → all User fields visible
    expect(fieldsAt(n, 'Post.author')).toEqual(['email', 'id', 'name', 'password']);
  });

  test('chain composition + defaults all stack at one path', () => {
    // Layer 1 picks {a,b,c,d}, Layer 2 picks {a,b,c}, defaults omits {b} → final {a,c}
    const n1 = withParent(lens, { root: { picks: ['id', 'title', 'secret', 'author'] } });
    const n2 = withParent(n1, {
      root: { picks: ['id', 'title', 'author'] },
      mapDefaults: { prisma: { models: { Post: { omits: ['title'] } } } },
    });
    expect(fieldsAt(n2, 'Post')).toEqual(['author', 'id']);
  });
});
