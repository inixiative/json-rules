import { describe, expect, test } from 'bun:test';
import {
  type Bridge,
  check,
  type LensFieldMap,
  Operator,
  recordWithBridgeData,
  stitchFieldMaps,
  validateRuleInLens,
} from '../index';

const id = { kind: 'scalar', type: 'String' } as const;

const app: LensFieldMap = {
  models: {
    Doc: { fields: { id, ownerId: id, orgId: id, org: { kind: 'object', type: 'Org' } } },
    Org: { fields: { id } },
  },
};
const actor: LensFieldMap = {
  models: {
    User: { fields: { id, email: id } },
    Token: { fields: { id } },
  },
};
const crm: LensFieldMap = { models: { Account: { fields: { id } } } };

const fromAnyModelOfApp: Bridge = {
  endpoints: [{ fieldMap: 'app' }, { fieldMap: 'actor', model: 'User' }],
  cardinality: 'oneToOne',
};

const bridgeFieldsOf = (set: ReturnType<typeof stitchFieldMaps>, map: string, model: string) =>
  Object.entries(set.maps[map]?.models[model]?.fields ?? {})
    .filter(([, field]) => field.kind === 'bridge')
    .map(([name]) => name);

describe('a supplied bridge whose first endpoint names only its map', () => {
  const stitched = stitchFieldMaps({ maps: { app, actor, crm }, bridges: [fromAnyModelOfApp] });

  test('every model of that map gains the bridge field, and no other map does', () => {
    expect(bridgeFieldsOf(stitched, 'app', 'Doc')).toEqual(['actor:User']);
    expect(bridgeFieldsOf(stitched, 'app', 'Org')).toEqual(['actor:User']);
    expect(bridgeFieldsOf(stitched, 'crm', 'Account')).toEqual([]);
  });

  test('it runs one way: the far model gains nothing back', () => {
    expect(bridgeFieldsOf(stitched, 'actor', 'User')).toEqual([]);
    expect(bridgeFieldsOf(stitched, 'actor', 'Token')).toEqual([]);
  });

  test('a rule on any model of the map reads the supplied row once its lens turns the bridge on', () => {
    const lensAt = (model: string) => ({
      parent: { ...stitched, mapName: 'app', model },
      root: { relations: { 'actor:User': {} } },
    });
    const reads = { field: 'id', operator: Operator.equals, path: 'actor:User.id' };
    expect(validateRuleInLens(reads, lensAt('Doc')).ok).toBe(true);
    expect(validateRuleInLens(reads, lensAt('Org')).ok).toBe(true);
  });

  test('a model of a map the bridge does not start from cannot read it', () => {
    const lens = {
      parent: { ...stitched, mapName: 'crm', model: 'Account' },
      root: { relations: {} },
    };
    expect(
      validateRuleInLens({ field: 'id', operator: Operator.equals, path: 'actor:User.id' }, lens)
        .ok,
    ).toBe(false);
  });

  test('both ends in one map: the far model gains no field to itself', () => {
    const within = stitchFieldMaps({
      maps: { actor },
      bridges: [
        {
          endpoints: [{ fieldMap: 'actor' }, { fieldMap: 'actor', model: 'User' }],
          cardinality: 'oneToOne',
        },
      ],
    });
    expect(bridgeFieldsOf(within, 'actor', 'Token')).toEqual(['actor:User']);
    expect(bridgeFieldsOf(within, 'actor', 'User')).toEqual([]);
  });

  test('a map with no models, or a map that is not in the set, is refused', () => {
    expect(() =>
      stitchFieldMaps({
        maps: { actor },
        bridges: [
          {
            endpoints: [{ fieldMap: 'nope' }, { fieldMap: 'actor', model: 'User' }],
            cardinality: 'oneToOne',
          },
        ],
      }),
    ).toThrow(/map 'nope' not found/);
  });

  test('only a supplied bridge may leave the model out: a joined bridge names one at both ends', () => {
    expect(() =>
      stitchFieldMaps({
        maps: { app, actor },
        bridges: [
          {
            endpoints: [
              { fieldMap: 'app', on: 'ownerId' },
              { fieldMap: 'actor', model: 'User', on: 'id' },
            ],
            cardinality: 'oneToOne',
          } as unknown as Bridge,
        ],
      }),
    ).toThrow(/a joined bridge names a model at both ends/);
  });

  test('the far end always names a model', () => {
    expect(() =>
      stitchFieldMaps({
        maps: { app, actor },
        bridges: [
          {
            endpoints: [{ fieldMap: 'app' }, { fieldMap: 'actor' }],
            cardinality: 'oneToOne',
          } as unknown as Bridge,
        ],
      }),
    ).toThrow(/the far end of a supplied bridge names a model/);
  });
});

describe('a supplied bridge from a map: rows and collisions', () => {
  const set = { maps: { app, actor, crm }, bridges: [fromAnyModelOfApp] };
  const data = { 'actor:User': [{ id: 'u1', email: 'a@b.c' }] };

  test('the supplied row is put on a record of any model of the map', () => {
    expect(recordWithBridgeData(set, 'app:Doc', { id: 'd1', ownerId: 'u1' }, data)).toEqual({
      id: 'd1',
      ownerId: 'u1',
      'actor:User': { id: 'u1', email: 'a@b.c' },
    });
    expect(recordWithBridgeData(set, 'app:Org', { id: 'o1' }, data)['actor:User']).toEqual({
      id: 'u1',
      email: 'a@b.c',
    });
  });

  test('a record of a map the bridge does not start from gets nothing', () => {
    expect(recordWithBridgeData(set, 'crm:Account', { id: 'a1' }, data)).toEqual({ id: 'a1' });
  });

  test('a rule on any model of the map reads it', () => {
    const owns = { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' };
    const doc = recordWithBridgeData(set, 'app:Doc', { id: 'd1', ownerId: 'u1' }, data);
    expect(check(owns, doc)).toBe(true);
    const other = recordWithBridgeData(set, 'app:Doc', { id: 'd2', ownerId: 'u2' }, data);
    expect(check(owns, other)).not.toBe(true);
  });

  test('a model already bridged to the same far model is refused, as two bridges to one model always are', () => {
    expect(() =>
      stitchFieldMaps({
        maps: { app, actor },
        bridges: [
          {
            endpoints: [
              { fieldMap: 'app', model: 'Doc', on: 'ownerId' },
              { fieldMap: 'actor', model: 'User', on: 'id' },
            ],
            cardinality: 'oneToOne',
          },
          fromAnyModelOfApp,
        ],
      }),
    ).toThrow(/bridge 'actor:User' already injected on 'app:Doc'/);
  });
});
