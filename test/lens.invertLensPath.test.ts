import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap, LensNarrowing } from '../index';
import {
  ArrayOperator,
  check,
  createLens,
  describeRule,
  invertLensPath,
  LensRefusal,
  Operator,
} from '../index';

const prisma: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        posts: { kind: 'object', type: 'Post', isList: true, relationName: 'UserPosts' },
        memberships: {
          kind: 'object',
          type: 'Membership',
          isList: true,
          relationName: 'UserMemberships',
        },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        published: { kind: 'scalar', type: 'Boolean' },
        authorId: { kind: 'scalar', type: 'String' },
        author: {
          kind: 'object',
          type: 'User',
          fromFields: ['authorId'],
          toFields: ['id'],
          relationName: 'UserPosts',
        },
      },
    },
    Membership: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        userId: { kind: 'scalar', type: 'String' },
        orgId: { kind: 'scalar', type: 'String' },
        user: {
          kind: 'object',
          type: 'User',
          fromFields: ['userId'],
          toFields: ['id'],
          relationName: 'UserMemberships',
        },
        org: {
          kind: 'object',
          type: 'Org',
          fromFields: ['orgId'],
          toFields: ['id'],
          relationName: 'OrgMemberships',
        },
      },
    },
    Org: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        memberships: {
          kind: 'object',
          type: 'Membership',
          isList: true,
          relationName: 'OrgMemberships',
        },
      },
    },
  },
};

const users: LensNarrowing = {
  parent: createLens({ maps: { prisma }, mapName: 'prisma', model: 'User' }),
  root: { relations: { posts: {}, memberships: { relations: { org: {} } } } },
};

const memberships: LensNarrowing = {
  parent: createLens({ maps: { prisma }, mapName: 'prisma', model: 'Membership' }),
  root: { relations: { user: { relations: { posts: {} } } } },
};

const inAcme: Condition = {
  field: 'memberships',
  arrayOperator: ArrayOperator.any,
  condition: { field: 'org.name', operator: Operator.equals, value: 'Acme' },
} as Condition;

describe('describeRule reads', () => {
  test('a column on the anchor reads the anchor', () => {
    expect(
      describeRule({ field: 'email', operator: Operator.equals, value: 'a' }, users).reads,
    ).toEqual([{ model: 'User', path: '' }]);
  });

  test('every relation crossed reads the model it leads to, with its path', () => {
    expect(describeRule(inAcme, users).reads).toEqual([
      { model: 'Membership', path: 'memberships' },
      { model: 'Org', path: 'memberships.org' },
    ]);
  });

  test('a relation read for presence alone still reads its model', () => {
    expect(
      describeRule({ field: 'posts', arrayOperator: ArrayOperator.notEmpty } as Condition, users)
        .reads,
    ).toEqual([{ model: 'Post', path: 'posts' }]);
  });

  test('a path the lens does not resolve reads nothing, and the gate reports it', () => {
    const description = describeRule({ field: 'nope', operator: Operator.equals, value: 1 }, users);
    expect(description.reads).toEqual([]);
    expect(description.errors.length).toBeGreaterThan(0);
  });
});

describe('invertLensPath', () => {
  test('one to-many hop binds the anchor through the key each row carries', () => {
    expect(
      invertLensPath(users, 'posts', [
        { id: 'p1', authorId: 'u1' },
        { id: 'p2', authorId: 'u1' },
        { id: 'p3', authorId: 'u2' },
      ]),
    ).toEqual({ field: 'id', operator: Operator.in, value: ['u1', 'u2'] } as Condition);
  });

  test('an earlier to-many hop wraps the bound key in any', () => {
    const condition = invertLensPath(users, 'memberships.org', [{ id: 'o1', name: 'Acme' }]);
    expect(condition).toEqual({
      field: 'memberships',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'orgId', operator: Operator.in, value: ['o1'] },
    } as Condition);
    const member = { id: 'u1', memberships: [{ id: 'm1', userId: 'u1', orgId: 'o1' }] };
    const stranger = { id: 'u2', memberships: [{ id: 'm2', userId: 'u2', orgId: 'o2' }] };
    expect(check(condition as Condition, member)).toBe(true);
    expect(check(condition as Condition, stranger)).not.toBe(true);
  });

  test('an earlier to-one hop prefixes the bound key', () => {
    expect(invertLensPath(memberships, 'user.posts', [{ id: 'p1', authorId: 'u1' }])).toEqual({
      field: 'user.id',
      operator: Operator.in,
      value: ['u1'],
    } as Condition);
  });

  test('a to-one hop whose key sits on the anchor binds the key the row is', () => {
    expect(invertLensPath(memberships, 'user', [{ id: 'u1' }])).toEqual({
      field: 'userId',
      operator: Operator.in,
      value: ['u1'],
    } as Condition);
  });

  test('null when no row carries the join key', () => {
    expect(invertLensPath(users, 'posts', [{ id: 'p1' }, { id: 'p2', authorId: null }])).toBeNull();
  });

  test('describeRule reads invert one by one', () => {
    for (const { path } of describeRule(inAcme, users).reads) {
      expect(invertLensPath(users, path, [{ id: 'x', orgId: 'o1', userId: 'u1' }])).not.toBeNull();
    }
  });

  test('refuses the anchor, a column, and a relation the lens does not turn on', () => {
    const codeOf = (path: string): string | undefined => {
      try {
        invertLensPath(users, path, [{ id: 'x' }]);
      } catch (error) {
        return error instanceof LensRefusal ? error.code : 'other';
      }
      return undefined;
    };
    expect(codeOf('')).toBe('invert_anchor');
    expect(codeOf('email')).toBe('invert_not_relation');
    expect(codeOf('memberships.user')).toBe('invert_unresolved');
  });
});
