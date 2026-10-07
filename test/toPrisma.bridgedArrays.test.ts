import { describe, expect, it } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge, FieldMap } from '../src/fieldMap/types';
import { toPrisma } from '../src/toPrisma';
import { getWhere } from './fixtures/helpers';

// A condition that crosses a bridge is unknown to Prisma. Where a matching child can make the
// rule false — none, all, atMost, exactly, or an aggregate over the matching children — the rule
// over-fetches every parent for check() to decide; any and atLeast only widen.

const appMap: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        posts: { kind: 'object', type: 'Post', isList: true, relationName: 'PostToUser' },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        views: { kind: 'scalar', type: 'Int' },
        authorId: { kind: 'scalar', type: 'String' },
        author: {
          kind: 'object',
          type: 'User',
          relationName: 'PostToUser',
          fromFields: ['authorId'],
          toFields: ['id'],
        },
      },
    },
  },
};
const crmMap: FieldMap = {
  models: {
    Event: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        postId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'app', model: 'Post', on: 'id' },
    { fieldMap: 'crm', model: 'Event', on: 'postId' },
  ],
  cardinality: 'oneToMany',
};
const stitched = stitchFieldMaps({ maps: { app: appMap, crm: crmMap }, bridges: [bridge] });
const opts = { map: stitched.maps.app, model: 'User' };
const bridged = { field: 'crm:Event.postId', operator: 'equals', value: 'p1' };
const where = (rule: object) => getWhere(toPrisma(rule as never, opts));

describe('a bridged condition over-fetches where it could narrow', () => {
  for (const [arrayOperator, count] of [
    ['none', undefined],
    ['all', undefined],
    ['atMost', 1],
    ['exactly', 0],
  ] as const)
    it(arrayOperator, () => {
      expect(where({ field: 'posts', arrayOperator, count, condition: bridged })).toEqual({});
    });

  it('an aggregate over the matching children', () => {
    expect(
      where({
        field: 'posts',
        aggregate: { mode: 'sum', field: 'views' },
        condition: bridged,
        operator: 'lessThan',
        value: 5,
      }),
    ).toEqual({});
  });

  it('any still requires a child', () => {
    expect(where({ field: 'posts', arrayOperator: 'any', condition: bridged })).toEqual({
      posts: { some: {} },
    });
  });
});
