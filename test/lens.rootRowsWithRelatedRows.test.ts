import { describe, expect, test } from 'bun:test';
import type {
  Bridge,
  Categorization,
  Condition,
  LensFieldMap,
  LensNarrowing,
  ValueExpression,
} from '../index';
import {
  ArrayOperator,
  bindLens,
  check,
  conditionForRootRowsWithRelatedRows,
  createLens,
  DateOperator,
  describeCategorization,
  describeRule,
  describeValue,
  engineGlobals,
  LensRefusal,
  Operator,
  toPrismaForRootRowsWithRelatedRows,
  UsageError,
  validateNarrowing,
} from '../index';

const prisma: LensFieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        tenantId: { kind: 'scalar', type: 'String' },
        crmAccountId: { kind: 'scalar', type: 'String' },
        createdAt: { kind: 'scalar', type: 'DateTime' },
        tags: { kind: 'scalar', type: 'String', isList: true },
        meta: { kind: 'scalar', type: 'Json' },
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
        active: { kind: 'scalar', type: 'Boolean' },
        createdAt: { kind: 'scalar', type: 'DateTime' },
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
        crmAccountId: { kind: 'scalar', type: 'String' },
        parentId: { kind: 'scalar', type: 'String' },
        parent: {
          kind: 'object',
          type: 'Org',
          fromFields: ['parentId'],
          toFields: ['id'],
          relationName: 'OrgTree',
        },
        children: {
          kind: 'object',
          type: 'Org',
          isList: true,
          relationName: 'OrgTree',
        },
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

const crm: LensFieldMap = {
  models: {
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
        deals: { kind: 'object', type: 'Deal', isList: true, relationName: 'AccountDeals' },
      },
    },
    Deal: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        accountId: { kind: 'scalar', type: 'String' },
        amount: { kind: 'scalar', type: 'Int' },
        account: {
          kind: 'object',
          type: 'Account',
          fromFields: ['accountId'],
          toFields: ['id'],
          relationName: 'AccountDeals',
        },
      },
    },
  },
};

const actor: LensFieldMap = {
  models: {
    Actor: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        role: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const bridges: Bridge[] = [
  {
    endpoints: [
      { fieldMap: 'prisma', model: 'User', on: 'crmAccountId' },
      { fieldMap: 'crm', model: 'Account', on: 'id' },
    ],
    cardinality: 'oneToOne',
  },
  {
    endpoints: [
      { fieldMap: 'prisma', model: 'Org', on: 'crmAccountId' },
      { fieldMap: 'crm', model: 'Account', on: 'id' },
    ],
    cardinality: 'oneToOne',
  },
  {
    endpoints: [
      { fieldMap: 'prisma', model: 'User' },
      { fieldMap: 'actor', model: 'Actor' },
    ],
    cardinality: 'oneToOne',
  },
];

const usersBase = createLens({
  maps: { prisma, crm, actor },
  bridges,
  mapName: 'prisma',
  model: 'User',
});

const users: LensNarrowing = {
  parent: usersBase,
  root: {
    relations: {
      posts: {},
      memberships: {
        relations: {
          org: { relations: { parent: {}, 'crm:Account': {} } },
        },
      },
      'crm:Account': { relations: { deals: {} } },
      'actor:Actor': {},
    },
  },
};

const memberships: LensNarrowing = {
  parent: createLens({ maps: { prisma }, mapName: 'prisma', model: 'Membership' }),
  root: {
    relations: {
      user: { relations: { posts: {} } },
      org: { relations: { parent: {} } },
    },
  },
};

const posts: LensNarrowing = {
  parent: createLens({ maps: { prisma }, mapName: 'prisma', model: 'Post' }),
  root: {
    relations: {
      author: {
        relations: {
          memberships: { relations: { org: {} } },
        },
      },
    },
  },
};

const inAcme: Condition = {
  field: 'memberships',
  arrayOperator: ArrayOperator.any,
  condition: { field: 'org.name', operator: Operator.equals, value: 'Acme' },
} as Condition;

const refusalCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof LensRefusal ? error.code : 'other';
  }
  return undefined;
};

describe('describeRule / describeValue / describeCategorization modelVisits', () => {
  test('a column on the anchor visits the anchor with mapName and empty path', () => {
    expect(
      describeRule({ field: 'email', operator: Operator.equals, value: 'a' }, users).modelVisits,
    ).toEqual([{ mapName: 'prisma', model: 'User', path: '' }]);
  });

  test('every crossed relation visits its target; back-relation does not falsely add the anchor', () => {
    expect(describeRule(inAcme, users).modelVisits).toEqual([
      { mapName: 'prisma', model: 'Membership', path: 'memberships' },
      { mapName: 'prisma', model: 'Org', path: 'memberships.org' },
    ]);
  });

  test('a forward FK from the anchor visits BOTH the anchor and the target (anchor FK edits invalidate)', () => {
    expect(
      describeRule(
        { field: 'user.email', operator: Operator.equals, value: 'a@b.com' },
        memberships,
      ).modelVisits,
    ).toEqual([
      { mapName: 'prisma', model: 'Membership', path: '' },
      { mapName: 'prisma', model: 'User', path: 'user' },
    ]);
  });

  test('a joined bridge from the anchor visits both the anchor (local on-key) and the far model; a supplied bridge visits only the far model', () => {
    expect(
      describeRule({ field: 'crm:Account.tier', operator: Operator.equals, value: 'gold' }, users)
        .modelVisits,
    ).toEqual([
      { mapName: 'prisma', model: 'User', path: '' },
      { mapName: 'crm', model: 'Account', path: 'crm:Account' },
    ]);
    expect(
      describeRule({ field: 'actor:Actor.role', operator: Operator.equals, value: 'admin' }, users)
        .modelVisits,
    ).toEqual([{ mapName: 'actor', model: 'Actor', path: 'actor:Actor' }]);
  });

  test('presence-only relation, value-side path ref, elementRefs (orderBy/aggregate.field) and Json column are all recorded', () => {
    expect(
      describeRule({ field: 'posts', arrayOperator: ArrayOperator.notEmpty } as Condition, users)
        .modelVisits,
    ).toEqual([{ mapName: 'prisma', model: 'Post', path: 'posts' }]);

    expect(
      describeRule(
        {
          field: 'memberships',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'org.name', operator: Operator.equals, path: 'email' },
        } as Condition,
        users,
      ).modelVisits,
    ).toEqual([
      { mapName: 'prisma', model: 'User', path: '' },
      { mapName: 'prisma', model: 'Membership', path: 'memberships' },
      { mapName: 'prisma', model: 'Org', path: 'memberships.org' },
    ]);

    expect(
      describeRule(
        {
          field: 'memberships',
          aggregate: { mode: 'pick', field: 'org.name' },
          orderBy: [{ field: 'createdAt', dir: 'desc' }],
          take: 1,
          operator: Operator.equals,
          value: 'Acme',
        } as Condition,
        users,
      ).modelVisits,
    ).toEqual([
      { mapName: 'prisma', model: 'Membership', path: 'memberships' },
      { mapName: 'prisma', model: 'Org', path: 'memberships.org' },
    ]);

    expect(
      describeRule({ field: 'meta.theme', operator: Operator.equals, value: 'dark' }, users)
        .modelVisits,
    ).toEqual([{ mapName: 'prisma', model: 'User', path: '' }]);
  });

  test('an unresolved path or an invalid 4.0 plain path past a to-many relation stays silent in modelVisits', () => {
    const missing = describeRule({ field: 'nope', operator: Operator.equals, value: 1 }, users);
    expect(missing.modelVisits).toEqual([]);
    expect(missing.errors.length).toBeGreaterThan(0);

    const pastToMany = describeRule(
      { field: 'memberships.org.name', operator: Operator.equals, value: 'Acme' },
      users,
    );
    expect(pastToMany.modelVisits).toEqual([]);
    expect(pastToMany.errors.length).toBeGreaterThan(0);

    // Ambiguous node (both operator and arrayOperator), invalid non-list array rule, and
    // relation-valued value ref all stay silent (matching validateRuleInLens).
    expect(
      describeRule(
        {
          field: 'posts',
          operator: Operator.exists,
          arrayOperator: ArrayOperator.notEmpty,
        } as unknown as Condition,
        users,
      ).modelVisits,
    ).toEqual([]);

    expect(
      describeRule(
        {
          field: 'email',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'posts', arrayOperator: ArrayOperator.notEmpty },
        } as Condition,
        users,
      ).modelVisits,
    ).toEqual([{ mapName: 'prisma', model: 'User', path: '' }]);

    expect(
      describeRule({ field: 'email', operator: Operator.equals, path: 'posts' } as Condition, users)
        .modelVisits,
    ).toEqual([{ mapName: 'prisma', model: 'User', path: '' }]);
  });

  test('handles scoped refs ($. / $$.), if/then/else, and scalar lists without mis-descending', () => {
    expect(
      describeRule(
        {
          if: { field: 'email', operator: Operator.exists },
          then: {
            field: 'memberships',
            arrayOperator: ArrayOperator.any,
            condition: { field: 'org.name', operator: Operator.equals, path: '$$.email' },
          },
          else: { field: 'posts', arrayOperator: ArrayOperator.notEmpty },
        } as Condition,
        users,
      ).modelVisits,
    ).toEqual([
      { mapName: 'prisma', model: 'User', path: '' },
      { mapName: 'prisma', model: 'Membership', path: 'memberships' },
      { mapName: 'prisma', model: 'Org', path: 'memberships.org' },
      { mapName: 'prisma', model: 'Post', path: 'posts' },
    ]);

    // Scalar list (tags: String[]) must not descend into condition as if elements were User rows.
    expect(
      describeRule(
        {
          field: 'tags',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'posts', arrayOperator: ArrayOperator.notEmpty },
        } as Condition,
        users,
      ).modelVisits,
    ).toEqual([{ mapName: 'prisma', model: 'User', path: '' }]);
  });

  test('describeValue and describeCategorization report the same modelVisits shape', () => {
    const expr: ValueExpression = {
      field: 'memberships',
      aggregate: { mode: 'count' },
      filter: { field: 'org.name', operator: Operator.equals, value: 'Acme' },
    };
    expect(describeValue(expr, users).modelVisits).toEqual([
      { mapName: 'prisma', model: 'Membership', path: 'memberships' },
      { mapName: 'prisma', model: 'Org', path: 'memberships.org' },
    ]);

    const categorization: Categorization = {
      cases: [{ if: inAcme, then: { path: 'email' } }],
      default: 'none',
    };
    expect(describeCategorization(categorization, users).modelVisits).toEqual([
      { mapName: 'prisma', model: 'User', path: '' },
      { mapName: 'prisma', model: 'Membership', path: 'memberships' },
      { mapName: 'prisma', model: 'Org', path: 'memberships.org' },
    ]);
  });
});

describe('conditionForRootRowsWithRelatedRows', () => {
  test('1-hop to-many binds the anchor key directly off the changed rows with caseInsensitive: false', () => {
    expect(
      conditionForRootRowsWithRelatedRows(users, 'posts', [
        { id: 'p1', authorId: 'u1' },
        { id: 'p2', authorId: 'u1' },
        { id: 'p3', authorId: 'u2' },
      ]),
    ).toEqual({
      field: 'id',
      operator: Operator.in,
      value: ['u1', 'u2'],
      caseInsensitive: false,
    } as Condition);
  });

  test('1-hop to-one binds the forward FK on the anchor', () => {
    expect(conditionForRootRowsWithRelatedRows(memberships, 'user', [{ id: 'u1' }])).toEqual({
      field: 'userId',
      operator: Operator.in,
      value: ['u1'],
      caseInsensitive: false,
    } as Condition);
  });

  test('2-hop to-many -> to-one wraps with any, and check() matches affected anchors', () => {
    const condition = conditionForRootRowsWithRelatedRows(users, 'memberships.org', [
      { id: 'o1', name: 'Acme' },
    ]);
    expect(condition).toEqual({
      field: 'memberships',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'orgId',
        operator: Operator.in,
        value: ['o1'],
        caseInsensitive: false,
      },
    } as Condition);
    const member = { id: 'u1', memberships: [{ id: 'm1', userId: 'u1', orgId: 'o1' }] };
    const stranger = { id: 'u2', memberships: [{ id: 'm2', userId: 'u2', orgId: 'o2' }] };
    expect(check(condition as Condition, member)).toBe(true);
    expect(check(condition as Condition, stranger)).not.toBe(true);
  });

  test('2-hop to-one -> to-many prefixes the bound key', () => {
    expect(
      conditionForRootRowsWithRelatedRows(memberships, 'user.posts', [
        { id: 'p1', authorId: 'u1' },
      ]),
    ).toEqual({
      field: 'user.id',
      operator: Operator.in,
      value: ['u1'],
      caseInsensitive: false,
    } as Condition);
  });

  test('3-hop mixed to-one -> to-many -> to-one wraps cleanly', () => {
    const condition = conditionForRootRowsWithRelatedRows(posts, 'author.memberships.org', [
      { id: 'o1' },
    ]);
    expect(condition).toEqual({
      field: 'author.memberships',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'orgId',
        operator: Operator.in,
        value: ['o1'],
        caseInsensitive: false,
      },
    } as Condition);
    expect(
      check(condition as Condition, {
        id: 'p1',
        author: { id: 'u1', memberships: [{ orgId: 'o1' }] },
      }),
    ).toBe(true);
  });

  test('before + after images on FK re-pointing reach both old and new anchors', () => {
    const before = { id: 'p1', authorId: 'u1' };
    const after = { id: 'p1', authorId: 'u2' };
    expect(conditionForRootRowsWithRelatedRows(users, 'posts', [before, after])).toEqual({
      field: 'id',
      operator: Operator.in,
      value: ['u1', 'u2'],
      caseInsensitive: false,
    } as Condition);
  });

  test('terminal joined bridge binds through its local on-key (1-hop and multi-hop)', () => {
    expect(
      conditionForRootRowsWithRelatedRows(users, 'crm:Account', [{ id: 'acc_1' }, { id: 'acc_2' }]),
    ).toEqual({
      field: 'crmAccountId',
      operator: Operator.in,
      value: ['acc_1', 'acc_2'],
      caseInsensitive: false,
    } as Condition);

    expect(
      conditionForRootRowsWithRelatedRows(users, 'memberships.org.crm:Account', [{ id: 'acc_1' }]),
    ).toEqual({
      field: 'memberships',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'org.crmAccountId',
        operator: Operator.in,
        value: ['acc_1'],
        caseInsensitive: false,
      },
    } as Condition);
  });

  test('composite FKs bind as anyOf(allOf(...)) with tuple deduplication, wrapped across hops', () => {
    const compositeMap: LensFieldMap = {
      models: {
        Org: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            members: { kind: 'object', type: 'Member', isList: true, relationName: 'OrgMembers' },
          },
        },
        Member: {
          fields: {
            orgId: { kind: 'scalar', type: 'String' },
            tenantKey: { kind: 'scalar', type: 'String' },
            seatCode: { kind: 'scalar', type: 'String' },
            org: {
              kind: 'object',
              type: 'Org',
              fromFields: ['orgId'],
              toFields: ['id'],
              relationName: 'OrgMembers',
            },
            seat: {
              kind: 'object',
              type: 'Seat',
              fromFields: ['tenantKey', 'seatCode'],
              toFields: ['tenantKey', 'code'],
              relationName: 'MemberSeat',
            },
          },
        },
        Seat: {
          fields: {
            tenantKey: { kind: 'scalar', type: 'String' },
            code: { kind: 'scalar', type: 'String' },
          },
        },
      },
    };
    const orgLens: LensNarrowing = {
      parent: createLens({ maps: { app: compositeMap }, mapName: 'app', model: 'Org' }),
      root: { relations: { members: { relations: { seat: {} } } } },
    };

    const condition = conditionForRootRowsWithRelatedRows(orgLens, 'members.seat', [
      { tenantKey: 't1', code: 'A' },
      { tenantKey: 't1', code: 'A' },
      { tenantKey: 't1', code: null },
      { tenantKey: 't2', code: 'B' },
    ]);
    expect(condition).toEqual({
      field: 'members',
      arrayOperator: ArrayOperator.any,
      condition: {
        any: [
          {
            all: [
              {
                field: 'tenantKey',
                operator: Operator.equals,
                value: 't1',
                caseInsensitive: false,
              },
              { field: 'seatCode', operator: Operator.equals, value: 'A', caseInsensitive: false },
            ],
          },
          {
            all: [
              {
                field: 'tenantKey',
                operator: Operator.equals,
                value: 't2',
                caseInsensitive: false,
              },
              { field: 'seatCode', operator: Operator.equals, value: 'B', caseInsensitive: false },
            ],
          },
        ],
      },
    } as Condition);
  });

  test('deduplicates Date join keys by instant and reads only own properties', () => {
    const map: LensFieldMap = {
      models: {
        Day: {
          fields: {
            at: { kind: 'scalar', type: 'DateTime' },
            toString: { kind: 'scalar', type: 'String' } as const,
            logs: { kind: 'object', type: 'Log', isList: true, relationName: 'DayLogs' },
            proto: { kind: 'object', type: 'Proto', isList: true, relationName: 'DayProto' },
          },
        },
        Log: {
          fields: {
            dayAt: { kind: 'scalar', type: 'DateTime' },
            day: {
              kind: 'object',
              type: 'Day',
              fromFields: ['dayAt'],
              toFields: ['at'],
              relationName: 'DayLogs',
            },
          },
        },
        Proto: {
          fields: {
            toString: { kind: 'scalar', type: 'String' } as const,
            day: {
              kind: 'object',
              type: 'Day',
              fromFields: ['toString'],
              toFields: ['toString'],
              relationName: 'DayProto',
            },
          },
        },
      },
    };
    const days: LensNarrowing = {
      parent: createLens({ maps: { app: map }, mapName: 'app', model: 'Day' }),
      root: { relations: { logs: {}, proto: {} } },
    };

    const cond = conditionForRootRowsWithRelatedRows(days, 'logs', [
      { dayAt: new Date('2026-11-22T00:00:00Z') },
      { dayAt: new Date('2026-11-22T00:00:00Z') },
    ]) as { value: Date[] };
    expect(cond.value).toHaveLength(1);

    // An empty object must NOT read Object.prototype.toString.
    expect(conditionForRootRowsWithRelatedRows(days, 'proto', [{}])).toBeNull();
  });

  test('returns null when rows are empty or carry no non-null join key', () => {
    expect(conditionForRootRowsWithRelatedRows(users, 'posts', [])).toBeNull();
    expect(
      conditionForRootRowsWithRelatedRows(users, 'posts', [
        { id: 'p1' },
        { id: 'p2', authorId: null },
      ]),
    ).toBeNull();
  });

  test('respects case sensitivity on IDs even when global string.caseInsensitive is true', () => {
    const condition = conditionForRootRowsWithRelatedRows(users, 'posts', [{ authorId: 'AbC' }]);
    engineGlobals.with({ string: { caseInsensitive: true } }, () => {
      expect(check(condition as Condition, { id: 'AbC' })).toBe(true);
      expect(check(condition as Condition, { id: 'abc' })).not.toBe(true);
    });
  });

  test('refuses anchor, columns, unresolved paths, supplied/non-terminal bridges, and missing/ambiguous keys', () => {
    expect(refusalCode(() => conditionForRootRowsWithRelatedRows(users, '', [{ id: 'x' }]))).toBe(
      'root_path',
    );
    expect(
      refusalCode(() => conditionForRootRowsWithRelatedRows(users, 'email', [{ id: 'x' }])),
    ).toBe('not_a_relation');
    expect(
      refusalCode(() =>
        conditionForRootRowsWithRelatedRows(users, 'memberships.user', [{ id: 'x' }]),
      ),
    ).toBe('not_in_lens');
    // A bare base Lens turns no relations on: fails closed with not_in_lens.
    expect(
      refusalCode(() =>
        conditionForRootRowsWithRelatedRows(usersBase, 'posts', [{ authorId: 'u1' }]),
      ),
    ).toBe('not_in_lens');
    expect(
      refusalCode(() => conditionForRootRowsWithRelatedRows(users, 'actor:Actor', [{ id: 'a1' }])),
    ).toBe('unsupported_bridge');
    expect(
      refusalCode(() =>
        conditionForRootRowsWithRelatedRows(users, 'crm:Account.deals', [
          { id: 'd1', accountId: 'a1' },
        ]),
      ),
    ).toBe('unsupported_bridge');

    // Ambiguous reverse relations without relationName fail closed instead of guessing.
    const ambiguousMap: LensFieldMap = {
      models: {
        User: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            reviewedTasks: { kind: 'object', type: 'Task', isList: true },
          },
        },
        Task: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            creatorId: { kind: 'scalar', type: 'String' },
            reviewerId: { kind: 'scalar', type: 'String' },
            creator: { kind: 'object', type: 'User', fromFields: ['creatorId'], toFields: ['id'] },
            reviewer: {
              kind: 'object',
              type: 'User',
              fromFields: ['reviewerId'],
              toFields: ['id'],
            },
          },
        },
      },
    };
    const ambiguousLens: LensNarrowing = {
      parent: createLens({ maps: { app: ambiguousMap }, mapName: 'app', model: 'User' }),
      root: { relations: { reviewedTasks: {} } },
    };
    expect(
      refusalCode(() =>
        conditionForRootRowsWithRelatedRows(ambiguousLens, 'reviewedTasks', [
          { id: 't1', creatorId: 'u1', reviewerId: 'u2' },
        ]),
      ),
    ).toBe('missing_relation_keys');
  });
});

describe('toPrismaForRootRowsWithRelatedRows', () => {
  // Layer 1: tenant scope + relations on, hiding join keys (`id`, `crmAccountId`, `orgId`).
  const tenantScopedUsers: LensNarrowing = {
    parent: usersBase,
    root: {
      picks: ['email'],
      where: { field: 'tenantId', operator: Operator.equals, value: 't1' },
      relations: {
        posts: { picks: ['published'] },
        memberships: {
          picks: ['active'],
          relations: {
            org: { picks: ['name'], relations: { 'crm:Account': {} } },
          },
        },
        'crm:Account': {},
      },
    },
  };

  // Layer 2: narrows memberships to active ones — the lens stack itself carries the clamp.
  const activeTenantUsers: LensNarrowing = {
    parent: tenantScopedUsers,
    root: {
      relations: {
        memberships: {
          where: { field: 'active', operator: Operator.equals, value: true },
        },
      },
    },
  };

  test('compiles 2-hop path even when join keys are hidden by picks, obeying every layer of the lens', () => {
    // Shallower lens (tenant-only): enforces tenantId clamp, no intermediate membership clamp.
    expect(
      toPrismaForRootRowsWithRelatedRows(tenantScopedUsers, {
        path: 'memberships.org',
        rows: [{ id: 'o1' }],
      }),
    ).toEqual({
      steps: [
        {
          operation: 'where',
          where: {
            AND: [
              { tenantId: { equals: 't1' } },
              { memberships: { some: { orgId: { in: ['o1'] } } } },
            ],
          },
        },
      ],
    });

    // Deeper lens (active memberships): automatically enforces both tenantId and active clamps.
    expect(
      toPrismaForRootRowsWithRelatedRows(activeTenantUsers, {
        path: 'memberships.org',
        rows: [{ id: 'o1' }],
      }),
    ).toEqual({
      steps: [
        {
          operation: 'where',
          where: {
            AND: [
              { tenantId: { equals: 't1' } },
              {
                memberships: {
                  some: {
                    AND: [{ active: { equals: true } }, { orgId: { in: ['o1'] } }],
                  },
                },
              },
            ],
          },
        },
      ],
    });
  });

  test('combines multiple targets with OR under one root clamp, and compiles terminal joined bridges', () => {
    const plan = toPrismaForRootRowsWithRelatedRows(activeTenantUsers, [
      { path: 'crm:Account', rows: [{ id: 'acc_1' }] },
      { path: 'memberships.org.crm:Account', rows: [{ id: 'acc_1' }] },
    ]);
    expect(plan).toEqual({
      steps: [
        {
          operation: 'where',
          where: {
            AND: [
              { tenantId: { equals: 't1' } },
              {
                OR: [
                  { crmAccountId: { in: ['acc_1'] } },
                  {
                    memberships: {
                      some: {
                        AND: [
                          { active: { equals: true } },
                          { org: { crmAccountId: { in: ['acc_1'] } } },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  test('does not emit mode: insensitive on join keys under global string.caseInsensitive: true', () => {
    engineGlobals.with({ string: { caseInsensitive: true } }, () => {
      const plan = toPrismaForRootRowsWithRelatedRows(tenantScopedUsers, {
        path: 'memberships.org',
        rows: [{ id: 'Org_AbC' }],
      });
      expect(plan).toEqual({
        steps: [
          {
            operation: 'where',
            where: {
              AND: [
                { tenantId: { equals: 't1', mode: 'insensitive' } },
                { memberships: { some: { orgId: { in: ['Org_AbC'] } } } },
              ],
            },
          },
        ],
      });
    });
  });

  test('returns null when no target carries keys, but still validates paths when rows are empty', () => {
    expect(toPrismaForRootRowsWithRelatedRows(tenantScopedUsers, [])).toBeNull();
    expect(
      toPrismaForRootRowsWithRelatedRows(tenantScopedUsers, { path: 'posts', rows: [] }),
    ).toBeNull();
    expect(
      refusalCode(() =>
        toPrismaForRootRowsWithRelatedRows(tenantScopedUsers, {
          path: 'memberships.user',
          rows: [],
        }),
      ),
    ).toBe('not_in_lens');
    // Error messages name toPrismaForRootRowsWithRelatedRows when called through it.
    expect(() =>
      toPrismaForRootRowsWithRelatedRows(tenantScopedUsers, { path: '', rows: [{ id: 'u1' }] }),
    ).toThrow(/toPrismaForRootRowsWithRelatedRows/);
  });

  test('threads now for relative-date clamps and respects multi-layer omits and wheres', () => {
    const datedUsers: LensNarrowing = {
      parent: usersBase,
      root: {
        picks: ['email'],
        where: {
          field: 'createdAt',
          dateOperator: DateOperator.onOrAfter,
          value: { ago: { days: 7 } },
        },
        relations: { posts: {}, memberships: { relations: { org: {} } } },
      },
    };
    expect(() =>
      toPrismaForRootRowsWithRelatedRows(datedUsers, { path: 'posts', rows: [{ authorId: 'u1' }] }),
    ).toThrow(UsageError);
    expect(
      toPrismaForRootRowsWithRelatedRows(
        datedUsers,
        { path: 'posts', rows: [{ authorId: 'u1' }] },
        { now: new Date('2026-11-22T00:00:00Z') },
      ),
    ).not.toBeNull();

    // Multi-layer narrowing: Layer 3 hides `posts` and adds a root clamp on top of activeTenantUsers.
    const layer3: LensNarrowing = {
      parent: activeTenantUsers,
      root: {
        omits: ['posts'],
        where: { field: 'email', operator: Operator.exists },
      },
    };
    expect(
      refusalCode(() =>
        toPrismaForRootRowsWithRelatedRows(layer3, { path: 'posts', rows: [{ authorId: 'u1' }] }),
      ),
    ).toBe('not_in_lens');
    const plan = toPrismaForRootRowsWithRelatedRows(layer3, {
      path: 'memberships.org',
      rows: [{ id: 'o1' }],
    });
    expect(plan).toEqual({
      steps: [
        {
          operation: 'where',
          where: {
            AND: [
              { tenantId: { equals: 't1' } },
              { email: { not: null } },
              {
                memberships: {
                  some: {
                    AND: [{ active: { equals: true } }, { orgId: { in: ['o1'] } }],
                  },
                },
              },
            ],
          },
        },
      ],
    });
  });

  test('reverse-direction joined bridge, to-one over composite FK (with NUL-safe dedup), and caller data error classification', () => {
    // Reverse direction of JoinedBridge: crm:Account -> prisma:User
    const crmBase = createLens({
      maps: { prisma, crm, actor },
      bridges,
      mapName: 'crm',
      model: 'Account',
    });
    const crmLens: LensNarrowing = {
      parent: crmBase,
      root: { relations: { 'prisma:User': {} } },
    };
    expect(
      conditionForRootRowsWithRelatedRows(crmLens, 'prisma:User', [
        { id: 'u1', crmAccountId: 'acc_9' },
      ]),
    ).toEqual({
      field: 'id',
      operator: Operator.in,
      value: ['acc_9'],
      caseInsensitive: false,
    } as Condition);

    // To-one prefix over composite FK + strings containing NUL bytes do not collide in tuple dedup.
    const compositeMap: LensFieldMap = {
      models: {
        Ticket: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            authorId: { kind: 'scalar', type: 'String' },
            author: {
              kind: 'object',
              type: 'Member',
              fromFields: ['authorId'],
              toFields: ['id'],
              relationName: 'TicketAuthor',
            },
          },
        },
        Member: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            a: { kind: 'scalar', type: 'String' },
            b: { kind: 'scalar', type: 'String' },
            seat: {
              kind: 'object',
              type: 'Seat',
              fromFields: ['a', 'b'],
              toFields: ['a', 'b'],
              relationName: 'MemberSeat',
            },
          },
        },
        Seat: {
          fields: {
            a: { kind: 'scalar', type: 'String' },
            b: { kind: 'scalar', type: 'String' },
          },
        },
      },
    };
    const ticketLens: LensNarrowing = {
      parent: createLens({ maps: { app: compositeMap }, mapName: 'app', model: 'Ticket' }),
      root: { relations: { author: { relations: { seat: {} } } } },
    };
    const nulCond = conditionForRootRowsWithRelatedRows(ticketLens, 'author.seat', [
      { a: 'x\u0000p:string:y', b: 'z' },
      { a: 'x', b: 'y\u0000p:string:z' },
    ]) as { any: unknown[] };
    expect(nulCond.any).toHaveLength(2);

    // Caller row-data error (invalid DateTime join key) must NOT be misclassified as LensRefusal('unsupported_clamp').
    const dateKeyMap: LensFieldMap = {
      models: {
        Day: {
          fields: {
            at: { kind: 'scalar', type: 'DateTime' },
            logs: { kind: 'object', type: 'Log', isList: true, relationName: 'DayLogs' },
          },
        },
        Log: {
          fields: {
            dayAt: { kind: 'scalar', type: 'DateTime' },
            day: {
              kind: 'object',
              type: 'Day',
              fromFields: ['dayAt'],
              toFields: ['at'],
              relationName: 'DayLogs',
            },
          },
        },
      },
    };
    const dayLens: LensNarrowing = {
      parent: createLens({ maps: { app: dateKeyMap }, mapName: 'app', model: 'Day' }),
      root: { relations: { logs: {} } },
    };
    let caught: unknown;
    try {
      toPrismaForRootRowsWithRelatedRows(dayLens, {
        path: 'logs',
        rows: [{ dayAt: 'not-a-date' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(LensRefusal);
  });

  test('multi-owner lens stack with progressive bindLens and parent: refs enforces every layer', () => {
    // Owner 1 (platform): turns on relations and declares `tenantId` bind.
    const platformLens: LensNarrowing = {
      parent: usersBase,
      root: {
        where: { field: 'tenantId', operator: Operator.equals, bind: 'tenantId' },
        relations: {
          memberships: { relations: { org: {} } },
        },
      },
    };
    // Owner 2 (org admin): narrows memberships with its own `onlyActive` bind.
    const orgAdminLens: LensNarrowing = {
      parent: platformLens,
      root: {
        relations: {
          memberships: {
            where: { field: 'active', operator: Operator.equals, bind: 'onlyActive' },
          },
        },
      },
    };
    // Owner 3 (app surface): hides join keys via `picks` and reads Owner 1's `parent:tenantId`.
    const surfaceLens: LensNarrowing = {
      parent: orgAdminLens,
      root: {
        picks: ['email'],
        where: { field: 'email', operator: Operator.endsWith, bind: 'emailSuffix' },
        relations: {
          memberships: {
            picks: ['active'],
            relations: {
              org: {
                picks: ['name'],
                where: { field: 'name', operator: Operator.notEquals, bind: 'parent:tenantId' },
              },
            },
          },
        },
      },
    };

    expect(validateNarrowing(surfaceLens).ok).toBe(true);

    // Partial binding (only Owner 1 bound): Owner 2 & 3 binds remain unbound -> UsageError.
    const afterOwner1 = bindLens(surfaceLens, { tenantId: 't1' });
    expect(() =>
      toPrismaForRootRowsWithRelatedRows(afterOwner1, {
        path: 'memberships.org',
        rows: [{ id: 'o1' }],
      }),
    ).toThrow(UsageError);

    // Progressive binding across owners 2 and 3 resolves every layer cleanly.
    const afterOwner2 = bindLens(afterOwner1, { onlyActive: true });
    const fullyBound = bindLens(afterOwner2, { emailSuffix: '@acme.com' });
    expect(
      toPrismaForRootRowsWithRelatedRows(fullyBound, {
        path: 'memberships.org',
        rows: [{ id: 'o1' }],
      }),
    ).toEqual({
      steps: [
        {
          operation: 'where',
          where: {
            AND: [
              { tenantId: { equals: 't1' } },
              { email: { endsWith: '@acme.com' } },
              {
                memberships: {
                  some: {
                    AND: [{ active: { equals: true } }, { orgId: { in: ['o1'] } }],
                  },
                },
              },
            ],
          },
        },
      ],
    });
  });

  test('polymorphic multi-arm rows drop null FK arms instead of emitting in [null]', () => {
    const polyMap: LensFieldMap = {
      models: {
        CustomerRelationship: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            customerUserId: { kind: 'scalar', type: 'String' },
            customerOrgId: { kind: 'scalar', type: 'String' },
            customerSpaceId: { kind: 'scalar', type: 'String' },
            customerUser: {
              kind: 'object',
              type: 'User',
              fromFields: ['customerUserId'],
              toFields: ['id'],
              relationName: 'RelUser',
            },
            customerOrg: {
              kind: 'object',
              type: 'Org',
              fromFields: ['customerOrgId'],
              toFields: ['id'],
              relationName: 'RelOrg',
            },
            customerSpace: {
              kind: 'object',
              type: 'Space',
              fromFields: ['customerSpaceId'],
              toFields: ['id'],
              relationName: 'RelSpace',
            },
          },
        },
        User: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            contacts: {
              kind: 'object',
              type: 'Contact',
              isList: true,
              relationName: 'UserContact',
            },
          },
        },
        Org: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            contacts: { kind: 'object', type: 'Contact', isList: true, relationName: 'OrgContact' },
          },
        },
        Space: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            contacts: {
              kind: 'object',
              type: 'Contact',
              isList: true,
              relationName: 'SpaceContact',
            },
          },
        },
        Contact: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            userId: { kind: 'scalar', type: 'String' },
            orgId: { kind: 'scalar', type: 'String' },
            spaceId: { kind: 'scalar', type: 'String' },
            user: {
              kind: 'object',
              type: 'User',
              fromFields: ['userId'],
              toFields: ['id'],
              relationName: 'UserContact',
            },
            org: {
              kind: 'object',
              type: 'Org',
              fromFields: ['orgId'],
              toFields: ['id'],
              relationName: 'OrgContact',
            },
            space: {
              kind: 'object',
              type: 'Space',
              fromFields: ['spaceId'],
              toFields: ['id'],
              relationName: 'SpaceContact',
            },
          },
        },
      },
    };
    const relLens: LensNarrowing = {
      parent: createLens({ maps: { app: polyMap }, mapName: 'app', model: 'CustomerRelationship' }),
      root: {
        relations: {
          customerUser: { relations: { contacts: {} } },
          customerOrg: { relations: { contacts: {} } },
          customerSpace: { relations: { contacts: {} } },
        },
      },
    };
    // Contact belongs only to a User (`orgId` and `spaceId` are null); passing the same row to all
    // three arms drops the two null arms and compiles only the matching arm.
    const changedContacts = [{ id: 'c1', userId: 'u1', orgId: null, spaceId: null }];
    expect(
      toPrismaForRootRowsWithRelatedRows(relLens, [
        { path: 'customerUser.contacts', rows: changedContacts },
        { path: 'customerOrg.contacts', rows: changedContacts },
        { path: 'customerSpace.contacts', rows: changedContacts },
      ]),
    ).toEqual({
      steps: [
        {
          operation: 'where',
          where: { customerUser: { id: { in: ['u1'] } } },
        },
      ],
    });
  });

  test('every non-root relation path emitted by modelVisits (including joined bridges) works in lookup', () => {
    const rule: Condition = {
      all: [inAcme, { field: 'crm:Account.tier', operator: Operator.equals, value: 'gold' }],
    } as Condition;
    const visits = describeRule(rule, users).modelVisits.filter((visit) => visit.path !== '');
    expect(visits.map((visit) => visit.path)).toEqual([
      'crm:Account',
      'memberships',
      'memberships.org',
    ]);
    for (const { path } of visits) {
      expect(
        conditionForRootRowsWithRelatedRows(users, path, [{ id: 'x1', userId: 'u1', orgId: 'o1' }]),
      ).not.toBeNull();
    }
  });
});
