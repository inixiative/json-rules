import { describe, expect, it } from 'bun:test';
import { Operator, toPrisma } from '../index';
import { getWhere } from './fixtures/helpers';

// The absent set of a path is not just a NULL leaf: an optional to-one hop can be NULL too, and
// Prisma's `{ rel: { col: { equals: null } } }` requires the relation to EXIST. check() reads a
// missing hop as undefined, so every negation must carry `{ rel: { is: null } }` per optional hop —
// licensed by the relation entry's isRequired, exactly as the leaf arm is licensed by the column's.
const map = {
  models: {
    User: {
      fields: {
        profile: { kind: 'object', type: 'Profile', isList: false, isRequired: false },
        account: { kind: 'object', type: 'Account', isList: false, isRequired: true },
        posts: { kind: 'object', type: 'Post', isList: true, isRequired: true },
      },
    },
    Profile: {
      fields: {
        bio: { kind: 'scalar', type: 'String', isRequired: false },
        createdAt: { kind: 'scalar', type: 'DateTime', isRequired: true },
        org: { kind: 'object', type: 'Org', isList: false, isRequired: false },
      },
    },
    Org: { fields: { name: { kind: 'scalar', type: 'String', isRequired: false } } },
    Account: { fields: { plan: { kind: 'scalar', type: 'String', isRequired: false } } },
    Post: { fields: { title: { kind: 'scalar', type: 'String', isRequired: false } } },
  },
} as never;

const NOW = new Date('2026-08-25T00:00:00Z');
const opts = { map, model: 'User', now: NOW };
const ABSENT_PROFILE = { profile: { is: null } };

describe('toPrisma — negations through an optional to-one carry an `is: null` arm per hop', () => {
  it('notEquals: nullable leaf arm AND the hop arm', () => {
    expect(
      getWhere(toPrisma({ field: 'profile.bio', operator: Operator.notEquals, value: 'x' }, opts)),
    ).toEqual({
      OR: [
        { profile: { bio: { not: 'x' } } },
        { profile: { bio: { equals: null } } },
        ABSENT_PROFILE,
      ],
    });
  });

  it('notIn: same arms', () => {
    expect(
      getWhere(toPrisma({ field: 'profile.bio', operator: Operator.notIn, value: ['x'] }, opts)),
    ).toEqual({
      OR: [
        { profile: { bio: { notIn: ['x'] } } },
        { profile: { bio: { equals: null } } },
        ABSENT_PROFILE,
      ],
    });
  });

  it('notExists on a REQUIRED leaf through an optional hop is only the hop arm', () => {
    expect(
      getWhere(toPrisma({ field: 'profile.createdAt', operator: Operator.notExists }, opts)),
    ).toEqual(ABSENT_PROFILE);
  });

  it('notExists on a nullable leaf through an optional hop is both arms', () => {
    expect(
      getWhere(toPrisma({ field: 'profile.bio', operator: Operator.notExists }, opts)),
    ).toEqual({
      OR: [{ profile: { bio: { equals: null } } }, ABSENT_PROFILE],
    });
  });

  it('exists stays positive: the relation must exist', () => {
    expect(getWhere(toPrisma({ field: 'profile.bio', operator: Operator.exists }, opts))).toEqual({
      profile: { bio: { not: null } },
    });
  });

  it('notBefore / notAfter on a required leaf through an optional hop', () => {
    expect(
      getWhere(
        toPrisma(
          { field: 'profile.createdAt', dateOperator: 'notAfter', value: '2026-06-01' } as never,
          opts,
        ),
      ),
    ).toEqual({
      OR: [
        { profile: { createdAt: { lte: new Date('2026-06-01T00:00:00.000Z') } } },
        ABSENT_PROFILE,
      ],
    });
  });

  it('notWithin keeps the clause-level NOT and adds the hop arm', () => {
    expect(
      getWhere(
        toPrisma(
          {
            field: 'profile.createdAt',
            dateOperator: 'notWithin',
            value: { ago: { days: 30 } },
          } as never,
          opts,
        ),
      ),
    ).toEqual({
      OR: [
        {
          NOT: { profile: { createdAt: { gte: new Date('2026-07-26T00:00:00.000Z'), lte: NOW } } },
        },
        ABSENT_PROFILE,
      ],
    });
  });

  it('a required to-one hop licenses no hop arm', () => {
    expect(
      getWhere(toPrisma({ field: 'account.plan', operator: Operator.notEquals, value: 'x' }, opts)),
    ).toEqual({
      OR: [{ account: { plan: { not: 'x' } } }, { account: { plan: { equals: null } } }],
    });
  });

  it('two optional hops → one arm per hop, outermost first', () => {
    expect(
      getWhere(
        toPrisma({ field: 'profile.org.name', operator: Operator.notEquals, value: 'x' }, opts),
      ),
    ).toEqual({
      OR: [
        { profile: { org: { name: { not: 'x' } } } },
        { profile: { org: { name: { equals: null } } } },
        ABSENT_PROFILE,
        { profile: { org: { is: null } } },
      ],
    });
  });

  it('positive operators never gain an arm', () => {
    expect(
      getWhere(toPrisma({ field: 'profile.bio', operator: Operator.equals, value: 'x' }, opts)),
    ).toEqual({ profile: { bio: { equals: 'x' } } });
  });
});
