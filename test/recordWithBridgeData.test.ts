import { describe, expect, test } from 'bun:test';
import {
  type Bridge,
  check,
  indexBridges,
  type LensFieldMap,
  Operator,
  recordWithBridgeData,
} from '../index';

const s = { kind: 'scalar', type: 'String' } as const;
const app: LensFieldMap = { models: { Doc: { fields: { id: s, ownerId: s, crmId: s } } } };
const actor: LensFieldMap = { models: { User: { fields: { id: s, orgId: s } } } };
const crm: LensFieldMap = { models: { Contact: { fields: { id: s, industry: s } } } };
const toActor: Bridge = {
  endpoints: [
    { fieldMap: 'app', model: 'Doc' },
    { fieldMap: 'actor', model: 'User' },
  ],
  cardinality: 'oneToOne',
};
const toCrm: Bridge = {
  endpoints: [
    { fieldMap: 'app', model: 'Doc', on: 'crmId' },
    { fieldMap: 'crm', model: 'Contact', on: 'id' },
  ],
  cardinality: 'oneToOne',
};
const set = { maps: { app, actor, crm }, bridges: [toActor, toCrm] };
const joined = indexBridges(set, { 'crm:Contact': [{ id: 'c1', industry: 'tech' }] });

describe('recordWithBridgeData: the far rows a record bridges to, filled by the caller-free embed', () => {
  test('a supplied bridge takes the row given for it; a joined one the row its key finds', () => {
    const doc = recordWithBridgeData(
      set,
      'app:Doc',
      { id: 'd1', ownerId: 'u1', crmId: 'c1' },
      { joined, supplied: { 'actor:User': { id: 'u1' } } },
    );
    expect(doc['actor:User']).toEqual({ id: 'u1' });
    expect(doc['crm:Contact']).toEqual({ id: 'c1', industry: 'tech' });
    const mine = {
      all: [
        { field: 'actor:User.id', operator: Operator.exists },
        { field: 'ownerId', operator: Operator.exists },
        { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
      ],
    };
    expect(check(mine, doc)).toBe(true);
  });

  test('a row the record brings under a bridge key is dropped, whatever model it names', () => {
    const forged = {
      id: 'd1',
      ownerId: 'u1',
      'actor:User': { id: 'u1' },
      'actor:Ghost': { id: 'x' },
      'crm:Contact': { industry: 'tech' },
    };
    const doc = recordWithBridgeData(set, 'app:Doc', forged);
    expect(Object.keys(doc).sort()).toEqual(['id', 'ownerId']);
    expect(check({ field: 'actor:User.id', operator: Operator.exists }, doc)).not.toBe(true);
  });

  test('a far row comes without bridge keys of its own', () => {
    const doc = recordWithBridgeData(
      set,
      'app:Doc',
      { id: 'd1' },
      { supplied: { 'actor:User': { id: 'u1', 'crm:Contact': { industry: 'tech' } } } },
    );
    expect(doc['actor:User']).toEqual({ id: 'u1' });
  });

  test('a far end with no row is left out, and a supplied row with no bridge throws', () => {
    const doc = recordWithBridgeData(set, 'app:Doc', { id: 'd1', crmId: 'nope' }, { joined });
    expect('actor:User' in doc || 'crm:Contact' in doc).toBe(false);
    expect(() =>
      recordWithBridgeData(set, 'app:Doc', { id: 'd1' }, { supplied: { 'actor:Usr': {} } }),
    ).toThrow(/no supplied bridge ends at `actor:Usr`/);
  });

  test('the record passed in is not changed', () => {
    const record = { id: 'd1', 'actor:User': { id: 'x' } };
    recordWithBridgeData(set, 'app:Doc', record, { supplied: { 'actor:User': { id: 'u1' } } });
    expect(record).toEqual({ id: 'd1', 'actor:User': { id: 'x' } });
  });
});
