import type { FieldMap } from '../../index';

/** Core blog schema: User / Post / Profile. */
export const blogMap: FieldMap = {
  User: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      name: { kind: 'scalar', type: 'String' },
      role: { kind: 'enum', type: 'UserRole' },
      metadata: { kind: 'scalar', type: 'Json' },
      createdAt: { kind: 'scalar', type: 'DateTime' },
      posts: { kind: 'object', type: 'Post', isList: true, fromFields: [], toFields: [] },
      profile: { kind: 'object', type: 'Profile', isList: false, fromFields: [], toFields: [] },
    },
  },
  Post: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      title: { kind: 'scalar', type: 'String' },
      published: { kind: 'scalar', type: 'Boolean' },
      authorId: { kind: 'scalar', type: 'String' },
      author: {
        kind: 'object',
        type: 'User',
        isList: false,
        fromFields: ['authorId'],
        toFields: ['id'],
      },
      settings: { kind: 'scalar', type: 'Json' },
    },
  },
  Profile: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      userId: { kind: 'scalar', type: 'String' },
      bio: { kind: 'scalar', type: 'String' },
      user: {
        kind: 'object',
        type: 'User',
        isList: false,
        fromFields: ['userId'],
        toFields: ['id'],
      },
    },
  },
};
