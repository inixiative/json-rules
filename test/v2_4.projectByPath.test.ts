import { describe, expect, test } from 'bun:test';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import { at } from './fixtures/helpers';
import { multiRelMap } from './fixtures/multiRelMap';

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

const postLens: Lens = { maps: { prisma: multiRelMap }, mapName: 'prisma', model: 'Post' };

describe('projectByPath — path-keyed projection (v2.4)', () => {
  test('lens-only (no narrowing): single root entry with all fields', () => {
    const projection = projectByPath(postLens);
    expect([...projection.keys()]).toEqual(['Post']);
    expect(Object.keys(at(projection, 'Post').fields).sort()).toEqual([
      'author',
      'authorId',
      'editor',
      'editorId',
      'id',
    ]);
  });

  test('root picks restrict the root visit', () => {
    const n = withParent(postLens, { root: { picks: ['id'] } });
    const projection = projectByPath(n);
    expect([...projection.keys()]).toEqual(['Post']);
    expect(Object.keys(at(projection, 'Post').fields).sort()).toEqual(['id']);
  });

  test('sibling relations to SAME model are independent (no leak)', () => {
    // Pre-2.4 bug: projectNarrowing collapsed sourceUser+editor → User.
    // 2.4: each path has its own resolved narrowing.
    const n = withParent(postLens, {
      root: {
        relations: {
          author: { picks: ['name'] },
          editor: { picks: ['id'] },
        },
      },
    });
    const projection = projectByPath(n);
    expect([...projection.keys()].sort()).toEqual(['Post', 'Post.author', 'Post.editor']);

    const author = at(projection, 'Post.author');
    expect(author.modelName).toBe('User');
    expect(Object.keys(author.fields).sort()).toEqual(['name']);

    const editor = at(projection, 'Post.editor');
    expect(editor.modelName).toBe('User');
    expect(Object.keys(editor.fields).sort()).toEqual(['id']);
  });

  test('mapDefaults applies at every visit AND intersects path narrowing', () => {
    // mapDefaults: User omits ['name'] everywhere.
    // author picks ['name', 'id'] → after defaults: just ['id'].
    // editor picks ['id'] → still ['id'].
    const n = withParent(postLens, {
      root: {
        relations: {
          author: { picks: ['name', 'id'] },
          editor: { picks: ['id'] },
        },
      },
      mapDefaults: { prisma: { models: { User: { omits: ['name'] } } } },
    });
    const projection = projectByPath(n);
    expect(Object.keys(at(projection, 'Post.author').fields).sort()).toEqual(['id']);
    expect(Object.keys(at(projection, 'Post.editor').fields).sort()).toEqual(['id']);
  });

  test('chain composition WITHIN a path intersects', () => {
    const n1 = withParent(postLens, {
      root: {
        relations: {
          author: { picks: ['name', 'id'] },
        },
      },
    });
    const n2 = withParent(n1, {
      root: {
        relations: {
          author: { picks: ['id'] }, // narrows further
        },
      },
    });
    const projection = projectByPath(n2);
    expect(Object.keys(at(projection, 'Post.author').fields).sort()).toEqual(['id']);
  });

  test('multi-layer chain: each layer contributes; descent picks up relations from any layer', () => {
    // Layer 1: declares author relation with name pick
    // Layer 2: declares editor relation with id pick + further narrows author
    // Layer 3: applies a mapDefaults omit to User
    const n1 = withParent(postLens, {
      root: { relations: { author: { picks: ['name', 'email', 'id'] } } },
    });
    const n2 = withParent(n1, {
      root: {
        relations: {
          author: { picks: ['name', 'email'] }, // narrows layer 1
          editor: { picks: ['id'] }, // new relation
        },
      },
    });
    const n3 = withParent(n2, {
      mapDefaults: { prisma: { models: { User: { omits: ['email'] } } } },
    });
    const projection = projectByPath(n3);
    expect([...projection.keys()].sort()).toEqual(['Post', 'Post.author', 'Post.editor']);
    // author: layer1 ∩ layer2 picks = {name, email}; mapDefaults omits email → {name}
    expect(Object.keys(at(projection, 'Post.author').fields).sort()).toEqual(['name']);
    // editor: only layer2 picks; mapDefaults still applies → {id} (email not picked anyway)
    expect(Object.keys(at(projection, 'Post.editor').fields).sort()).toEqual(['id']);
  });
});

// Recursive same-model in ONE path: SpaceUser at depth 1 and depth 3 are independent visits.
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
const userLens: Lens = { maps: { prisma: recursiveMap }, mapName: 'prisma', model: 'User' };

describe('projectByPath — recursive same model on one path', () => {
  test('two visits to SpaceUser on the same path each have their own narrowing', () => {
    const n = withParent(userLens, {
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
    const projection = projectByPath(n);
    expect([...projection.keys()].sort()).toEqual([
      'User',
      'User.spaceUsers',
      'User.spaceUsers.user',
      'User.spaceUsers.user.spaceUsers',
    ]);

    expect(Object.keys(at(projection, 'User.spaceUsers').fields).sort()).toEqual([
      'spaceId',
      'user',
    ]);
    expect(Object.keys(at(projection, 'User.spaceUsers.user.spaceUsers').fields).sort()).toEqual([
      'orgId',
      'role',
    ]);
  });

  test('mapDefaults applies at BOTH SpaceUser visits', () => {
    const n = withParent(userLens, {
      root: {
        relations: {
          spaceUsers: {
            relations: {
              user: {
                relations: {
                  spaceUsers: {},
                },
              },
            },
          },
        },
      },
      mapDefaults: { prisma: { models: { SpaceUser: { omits: ['role'] } } } },
    });
    const projection = projectByPath(n);
    const v1 = at(projection, 'User.spaceUsers').fields;
    const v2 = at(projection, 'User.spaceUsers.user.spaceUsers').fields;
    expect(v1.role).toBeUndefined();
    expect(v2.role).toBeUndefined();
    expect(v1.spaceId).toBeDefined();
    expect(v2.orgId).toBeDefined();
  });
});

// Enum narrowing across both layers.
const enumMap: FieldMap = {
  models: {
    Inquiry: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        status: { kind: 'enum', type: 'InquiryStatus' },
        type: { kind: 'enum', type: 'InquiryType' },
      },
    },
  },
  enums: {
    InquiryStatus: ['draft', 'open', 'closed', 'canceled'],
    InquiryType: ['question', 'feedback', 'bug'],
  },
};
const inquiryLens: Lens = { maps: { prisma: enumMap }, mapName: 'prisma', model: 'Inquiry' };

describe('projectByPath — enum narrowing', () => {
  test('mapDefaults enums narrows registry; per-field enumOmits intersects', () => {
    const n = withParent(inquiryLens, {
      root: { enumOmits: { status: ['draft'] } },
      mapDefaults: {
        prisma: { enums: { InquiryStatus: { omits: ['canceled'] } } },
      },
    });
    const projection = projectByPath(n);
    const statusField = at(projection, 'Inquiry').fields.status;
    expect([...(statusField.values ?? [])].sort()).toEqual(['closed', 'open']);
  });
});

describe('projectByPath — where clauses preserved per visit', () => {
  test('root.where lives at root visit; relations.X.where lives at that visit', () => {
    const n = withParent(postLens, {
      root: {
        where: { field: 'id', operator: Operator.exists },
        relations: {
          author: {
            where: { field: 'name', operator: Operator.exists },
          },
        },
      },
    });
    const projection = projectByPath(n);
    expect(at(projection, 'Post').whereClauses).toEqual([
      { field: 'id', operator: Operator.exists },
    ]);
    expect(at(projection, 'Post.author').whereClauses).toEqual([
      { field: 'name', operator: Operator.exists },
    ]);
  });
});
