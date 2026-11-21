import { describe, expect, test } from 'bun:test';
import {
  type Bridge,
  check,
  indexBridges,
  isJoinedBridge,
  type LensFieldMap,
  Operator,
  readOwnPath,
  stitchFieldMaps,
  validateRuleInLens,
} from '../index';

const app: LensFieldMap = {
  models: {
    Doc: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        ownerId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const actor: LensFieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        orgId: { kind: 'scalar', type: 'String' },
        org: { kind: 'object', type: 'Org' },
      },
    },
    Org: { fields: { id: { kind: 'scalar', type: 'String' } } },
  },
};
const supplied: Bridge = {
  endpoints: [
    { fieldMap: 'app', model: 'Doc' },
    { fieldMap: 'actor', model: 'User' },
  ],
  cardinality: 'oneToOne',
};
const stitched = stitchFieldMaps({ maps: { app, actor }, bridges: [supplied] });
const lens = {
  parent: { ...stitched, mapName: 'app', model: 'Doc' },
  root: { relations: { 'actor:User': {} } },
};

describe('a supplied bridge: no join, the far row comes on the record', () => {
  test('is not a joined bridge', () => {
    expect(isJoinedBridge(supplied)).toBe(false);
  });

  test('stitches with no `on` and is read through the lens like any bridge', () => {
    expect(
      validateRuleInLens({ field: 'actor:User.email', operator: Operator.equals, value: 'a' }, lens)
        .ok,
    ).toBe(true);
    expect(
      validateRuleInLens(
        { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
        lens,
      ).ok,
    ).toBe(true);
    // Only what the lens turns on: the far model's own relations stay off.
    expect(
      validateRuleInLens(
        { field: 'actor:User.org.id', operator: Operator.equals, value: 'o' },
        lens,
      ).ok,
    ).toBe(false);
    expect(
      validateRuleInLens({ field: 'actor:Usr.email', operator: Operator.equals, value: 'a' }, lens)
        .ok,
    ).toBe(false);
  });

  test('check reads the supplied row under its endpoint key', () => {
    const row = { id: 'd', ownerId: 'u1', 'actor:User': { id: 'u1', email: 'a' } };
    expect(check({ field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' }, row)).toBe(
      true,
    );
  });

  test('indexBridges has nothing to index for it', () => {
    expect(indexBridges(stitched, { 'actor:User': [{ id: 'u1' }] })).toEqual({});
  });

  test('an `on` on one side only, or a supplied bridge that is not one-to-one, is refused', () => {
    expect(() =>
      stitchFieldMaps({
        maps: { app, actor },
        bridges: [
          {
            endpoints: [
              { fieldMap: 'app', model: 'Doc', on: 'ownerId' },
              { fieldMap: 'actor', model: 'User' },
            ],
            cardinality: 'oneToOne',
          } as Bridge,
        ],
      }),
    ).toThrow('joins on one side only');
    expect(() =>
      stitchFieldMaps({
        maps: { app, actor },
        bridges: [{ ...supplied, cardinality: 'oneToMany' } as unknown as Bridge],
      }),
    ).toThrow('not oneToOne');
  });
});

describe('a supplied bridge runs one way in the stitched map too', () => {
  test('only the first endpoint gains a bridge field, so no lens reads back through it', () => {
    expect(Object.hasOwn(stitched.maps.app.models.Doc.fields, 'actor:User')).toBe(true);
    expect(Object.hasOwn(stitched.maps.actor.models.User.fields, 'app:Doc')).toBe(false);
    const fromUser = {
      parent: { ...stitched, mapName: 'actor', model: 'User' },
      root: { relations: { 'app:Doc': {} } },
    };
    expect(
      validateRuleInLens({ field: 'app:Doc.id', operator: Operator.equals, value: 'd' }, fromUser)
        .ok,
    ).toBe(false);
  });

  test('a joined bridge still stitches both ways', () => {
    const joined: Bridge = {
      endpoints: [
        { fieldMap: 'app', model: 'Doc', on: 'ownerId' },
        { fieldMap: 'actor', model: 'User', on: 'id' },
      ],
      cardinality: 'oneToOne',
    };
    const both = stitchFieldMaps({ maps: { app, actor }, bridges: [joined] });
    expect(Object.hasOwn(both.maps.actor.models.User.fields, 'app:Doc')).toBe(true);
  });

  test('readOwnPath reads own properties only', () => {
    expect(readOwnPath({ a: [{ b: 1 }] }, 'a[0].b')).toBe(1);
    expect(readOwnPath({}, 'toString')).toBeUndefined();
  });
});
