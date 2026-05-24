import { describe, expect, it } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { ArrayOperator, Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';
import { getWhere } from './fixtures/helpers';

// Adversarial: hide a bridge field inside an arrayRule.condition, then place
// that arrayRule in the `if` of an implication. The if/then guard must walk
// into nested conditions to catch this — otherwise the outer NOT(ifClause) form
// corrupts the implication semantics, dropping branches silently.
const appMap: FieldMap = {
  User: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      tier: { kind: 'scalar', type: 'String' },
      posts: { kind: 'object', type: 'Post', isList: true },
    },
  },
  Post: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      authorId: { kind: 'scalar', type: 'String' },
      published: { kind: 'scalar', type: 'Boolean' },
    },
  },
};
const crmMap: FieldMap = {
  Event: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      postId: { kind: 'scalar', type: 'String' },
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

describe('bridge nested inside arrayRule.condition under if/then — toPrisma', () => {
  it('bridge in `if` arrayRule.condition → over-fetch ({})', () => {
    const rule = {
      if: {
        // posts→Post (object relation, list). Inner condition hits Post's bridge to Event.
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: {
          field: 'crm:Event.postId',
          operator: Operator.equals,
          value: 'p1',
        },
      },
      then: { field: 'tier', operator: Operator.equals, value: 'gold' },
    };
    expect(getWhere(toPrisma(rule, opts))).toEqual({});
  });

  it('bridge in `then` arrayRule.condition (with else) → over-fetch', () => {
    const rule = {
      if: { field: 'tier', operator: Operator.equals, value: 'gold' },
      then: {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'crm:Event.postId', operator: Operator.equals, value: 'p1' },
      },
      else: { field: 'tier', operator: Operator.equals, value: 'silver' },
    };
    expect(getWhere(toPrisma(rule, opts))).toEqual({});
  });

  it('bridge buried two levels deep (inside `all` inside arrayRule.condition) → over-fetch', () => {
    const rule = {
      if: {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: {
          all: [
            { field: 'published', operator: Operator.equals, value: true },
            { field: 'crm:Event.postId', operator: Operator.equals, value: 'p1' },
          ],
        },
      },
      then: { field: 'tier', operator: Operator.equals, value: 'gold' },
    };
    expect(getWhere(toPrisma(rule, opts))).toEqual({});
  });

  it('non-bridge arrayRule.condition under if/then is unchanged (regression guard)', () => {
    const rule = {
      if: {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'published', operator: Operator.equals, value: true },
      },
      then: { field: 'tier', operator: Operator.equals, value: 'gold' },
    };
    // Should NOT over-fetch — emit a real implication
    const where = getWhere(toPrisma(rule, opts));
    expect(where).not.toEqual({});
  });
});

describe('bridge nested inside arrayRule.condition under if/then — toSql', () => {
  // Note: toSql throws on `any`-with-condition (NON_SQL_TARGETS in operator catalog).
  // The guard must detect the bridge in the if-clause BEFORE recursing into the
  // unsupported arrayRule — otherwise we hit the throw instead of over-fetching.
  it('bridge in `if` arrayRule.condition → TRUE (guard catches before throw)', () => {
    const rule = {
      if: {
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'crm:Event.postId', operator: Operator.equals, value: 'p1' },
      },
      then: { field: 'tier', operator: Operator.equals, value: 'gold' },
    };
    expect(toSql(rule, opts).sql.trim()).toBe('TRUE');
  });
});
