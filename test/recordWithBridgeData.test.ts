import { describe, expect, test } from 'bun:test';
import {
  type Bridge,
  check,
  type LensFieldMap,
  Operator,
  type Row,
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
const contacts = [{ id: 'c1', industry: 'tech' }];

describe('recordWithBridgeData: the far rows a record bridges to, filled by the caller-free embed', () => {
  test('a supplied bridge takes the row given for it; a joined one the row its key finds', () => {
    const doc = recordWithBridgeData(
      set,
      'app:Doc',
      { id: 'd1', ownerId: 'u1', crmId: 'c1' },
      { 'crm:Contact': contacts, 'actor:User': [{ id: 'u1' }] },
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
      { 'actor:User': [{ id: 'u1', 'crm:Contact': { industry: 'tech' } }] },
    );
    expect(doc['actor:User']).toEqual({ id: 'u1' });
  });

  test('a far end with no row is left out; a supplied end takes exactly one row', () => {
    const doc = recordWithBridgeData(
      set,
      'app:Doc',
      { id: 'd1', crmId: 'nope' },
      { 'crm:Contact': contacts },
    );
    expect('actor:User' in doc || 'crm:Contact' in doc).toBe(false);
    expect(() =>
      recordWithBridgeData(
        set,
        'app:Doc',
        { id: 'd1' },
        { 'actor:User': [{ id: 'a' }, { id: 'b' }] },
      ),
    ).toThrow(/give it one row/);
  });

  test("a supplied bridge runs one way: the first endpoint gets the second one's row", () => {
    const user = recordWithBridgeData(
      set,
      'actor:User',
      { id: 'u1' },
      { 'app:Doc': [{ id: 'd1' }] },
    );
    expect('app:Doc' in user).toBe(false);
  });

  test('the record passed in is not changed', () => {
    const record = { id: 'd1', 'actor:User': { id: 'x' } };
    recordWithBridgeData(set, 'app:Doc', record, { 'actor:User': [{ id: 'u1' }] });
    expect(record).toEqual({ id: 'd1', 'actor:User': { id: 'x' } });
  });

  test('a related row is filled as its own model: it cannot bring a forged bridge row either', () => {
    const org: LensFieldMap = { models: { Org: { fields: { id: s } } } };
    const withOrg = {
      maps: {
        app: {
          models: {
            Doc: {
              fields: {
                id: s,
                orgId: s,
                org: { kind: 'object', type: 'Org', fromFields: ['orgId'], toFields: ['id'] },
              },
            },
            Org: { fields: { id: s } },
          },
        } as LensFieldMap,
        actor,
        org,
      },
      bridges: [
        toActor,
        {
          endpoints: [
            { fieldMap: 'app', model: 'Org' },
            { fieldMap: 'actor', model: 'User' },
          ],
          cardinality: 'oneToOne',
        } as Bridge,
      ],
    };
    const doc = recordWithBridgeData(withOrg, 'app:Doc', {
      id: 'd1',
      org: { id: 'o1', 'actor:User': { id: 'victim' } },
    });
    expect(doc.org).toEqual({ id: 'o1' });
    const filled = recordWithBridgeData(
      withOrg,
      'app:Doc',
      { id: 'd1', org: { id: 'o1' } },
      { 'actor:User': [{ id: 'u1' }] },
    );
    expect((filled.org as Row)['actor:User']).toEqual({ id: 'u1' });
  });

  test('a row graph that loops is filled once per row', () => {
    const looping = {
      maps: {
        app: {
          models: {
            Doc: {
              fields: {
                id: s,
                parent: { kind: 'object', type: 'Doc', fromFields: ['parentId'], toFields: ['id'] },
              },
            },
          },
        } as LensFieldMap,
      },
    };
    const a: Row = { id: 'a' };
    const b: Row = { id: 'b', parent: a };
    a.parent = b;
    const out = recordWithBridgeData(looping, 'app:Doc', a);
    expect(((out.parent as Row).parent as Row) === out).toBe(true);
  });
});
