import { describe, expect, it } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { ArrayOperator, Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { getWhere } from './fixtures/helpers';

// User has many Posts (Prisma list relation). Posts have a Json `metadata` field
// and bridge to a CRM Event. Inner conditions in some/every/none must resolve
// against Post (not User) so JSON-path detection and bridge detection fire.
const userMap: FieldMap = {
  User: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      posts: { kind: 'object', type: 'Post', isList: true },
    },
  },
  Post: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      authorId: { kind: 'scalar', type: 'String' },
      published: { kind: 'scalar', type: 'Boolean' },
      metadata: { kind: 'scalar', type: 'Json' },
    },
  },
};
const crmMap: FieldMap = {
  Event: {
    fields: { id: { kind: 'scalar', type: 'String' }, postId: { kind: 'scalar', type: 'String' } },
  },
};
const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'app', model: 'Post', on: 'id' },
    { fieldMap: 'crm', model: 'Event', on: 'postId' },
  ],
  cardinality: 'oneToMany',
};
const stitched = stitchFieldMaps({
  maps: { app: userMap, crm: crmMap },
  bridges: [bridge],
});
const opts = { map: stitched.maps.app, model: 'User' };

describe('toPrisma relation array operators — inner condition resolves against the relation target', () => {
  it('some/every/none with inner JSON-path: JSON detection fires on Post.metadata', () => {
    // Inner field 'metadata.theme' is a Json path on Post (not on User).
    // With the bug: inner buildCondition uses User as model → walkFieldPath
    // doesn't find `metadata` on User → falls back to nested filter `metadata.theme`.
    // With the fix: model context flips to Post → emits Prisma's
    //   { metadata: { path: ['theme'], equals: 'dark' } }
    const result = toPrisma(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'metadata.theme', operator: Operator.equals, value: 'dark' },
      },
      opts,
    );
    const where = getWhere(result);
    // Drill into posts.some.metadata
    expect(where).toHaveProperty(['posts', 'some', 'metadata']);
    const metadataFilter = (where.posts as Record<string, Record<string, unknown>>).some.metadata;
    // Json-path detection should produce { path: [...], equals: ... }, not nested string
    expect(metadataFilter).toHaveProperty('path');
    expect((metadataFilter as { path: string[] }).path).toEqual(['theme']);
  });

  it('some/every/none with inner bridge field: bridge detection fires → emits {}', () => {
    // Inner condition references a bridge field on Post.
    // With the bug: inner buildCondition uses User → bridge field not found on
    // User → produces an invalid Prisma filter naming a non-existent field.
    // With the fix: model context flips to Post → bridge detected → emits {} (over-fetch).
    const result = toPrisma(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'crm:Event.postId', operator: Operator.equals, value: 'p1' },
      },
      opts,
    );
    const where = getWhere(result);
    // Inner clause should be {} (over-fetch) since the inner field hits a bridge.
    expect(where).toEqual({ posts: { some: {} } });
  });

  it('regression: scalar field on inner condition still works', () => {
    const result = toPrisma(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'published', operator: Operator.equals, value: true },
      },
      opts,
    );
    expect(getWhere(result)).toEqual({ posts: { every: { published: { equals: true } } } });
  });
});
