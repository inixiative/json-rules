import { describe, expect, test } from 'bun:test';
import {
  ArrayOperator,
  type Bridge,
  check,
  type LensFieldMap,
  Operator,
  type Row,
  recordWithBridgeData,
  stitchFieldMaps,
  validateRule,
  validateRuleInLens,
} from '../index';

// Four sources: the app's database, a CRM, a security tool and who is acting.
const s = { kind: 'scalar', type: 'String' } as const;
const db: LensFieldMap = { models: { Account: { fields: { id: s, ownerId: s, crmId: s } } } };
const crm: LensFieldMap = { models: { Contact: { fields: { id: s, industry: s } } } };
const sec: LensFieldMap = {
  models: {
    Device: { fields: { serial: s, risk: s, contactId: s, ownerUserId: s } },
    Finding: { fields: { id: s, deviceSerial: s, severity: s } },
  },
};
const scan: LensFieldMap = { models: { Finding: { fields: { id: s, serial: s, severity: s } } } };
const actor: LensFieldMap = { models: { User: { fields: { id: s } } } };

const accountToContact: Bridge = {
  endpoints: [
    { fieldMap: 'db', model: 'Account', on: 'crmId' },
    { fieldMap: 'crm', model: 'Contact', on: 'id' },
  ],
  cardinality: 'oneToOne',
};
const contactToDevices: Bridge = {
  endpoints: [
    { fieldMap: 'crm', model: 'Contact', on: 'id' },
    { fieldMap: 'sec', model: 'Device', on: 'contactId' },
  ],
  cardinality: 'oneToMany',
};
const accountToActor: Bridge = {
  endpoints: [
    { fieldMap: 'db', model: 'Account' },
    { fieldMap: 'actor', model: 'User' },
  ],
  cardinality: 'oneToOne',
};
// The acting user (supplied) joins on to the devices it owns, and each device to its scan findings.
const actorToDevices: Bridge = {
  endpoints: [
    { fieldMap: 'actor', model: 'User', on: 'id' },
    { fieldMap: 'sec', model: 'Device', on: 'ownerUserId' },
  ],
  cardinality: 'oneToMany',
};
const deviceToFindings: Bridge = {
  endpoints: [
    { fieldMap: 'sec', model: 'Device', on: 'serial' },
    { fieldMap: 'scan', model: 'Finding', on: 'serial' },
  ],
  cardinality: 'oneToMany',
};
const set = {
  maps: { db, crm, sec, scan, actor },
  bridges: [accountToContact, contactToDevices, accountToActor, actorToDevices, deviceToFindings],
};

const data = {
  'crm:Contact': [
    { id: 'c1', industry: 'tech', 'db:Account': { ownerId: 'forged' } },
    { id: 'c2', industry: 'retail' },
  ],
  'sec:Device': [
    { serial: 'd1', risk: 'low', contactId: 'c1', ownerUserId: 'u1' },
    { serial: 'd2', risk: 'high', contactId: 'c1', 'actor:User': [{ id: 'forged' }] },
    { serial: 'd3', risk: 'high', contactId: 'c2', ownerUserId: 'u1' },
  ],
  'scan:Finding': [
    { id: 'f1', serial: 'd1', severity: 'low' },
    { id: 'f2', serial: 'd1', severity: 'critical' },
    { id: 'f3', serial: 'd3', severity: 'low' },
  ],
  'actor:User': [{ id: 'u1' }],
};
const account = { id: 'a1', ownerId: 'u1', crmId: 'c1', 'sec:Device': [{ risk: 'low' }] };
const exists = (field: string) => ({ field, operator: Operator.exists });

describe('recordWithBridgeData across many bridges, in both directions', () => {
  const filled = recordWithBridgeData(set, 'db:Account', account, data);

  test('every bridge from the record is filled, and the far rows bridges in turn', () => {
    expect((filled['actor:User'] as { id: string }).id).toBe('u1');
    const contact = filled['crm:Contact'] as Record<string, unknown>;
    expect(contact.industry).toBe('tech');
    expect((contact['sec:Device'] as { serial: string }[]).map((d) => d.serial)).toEqual([
      'd1',
      'd2',
    ]);
  });

  test('no row on any side brings its own bridge keys, and a chain never re-enters', () => {
    expect('sec:Device' in filled).toBe(false);
    const contact = filled['crm:Contact'] as Record<string, unknown>;
    expect('db:Account' in contact).toBe(false);
    const [, risky] = contact['sec:Device'] as Record<string, unknown>[];
    expect('actor:User' in risky).toBe(false);
  });

  test('one rule reads the database, the CRM, the security tool and the actor', () => {
    const rule = {
      all: [
        exists('ownerId'),
        exists('actor:User.id'),
        { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
        exists('crm:Contact.industry'),
        { field: 'crm:Contact.industry', operator: Operator.equals, value: 'tech' },
      ],
    };
    expect(validateRule(rule, { positive: true }).ok).toBe(true);
    expect(check(rule, filled)).toBe(true);
    expect(
      check(
        {
          field: 'crm:Contact.sec:Device',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'risk', operator: Operator.equals, value: 'high' },
        },
        filled,
      ),
    ).toBe(true);
  });

  test('read from the far end, the same bridges run back: a device reaches its account and actor', () => {
    const device = recordWithBridgeData(
      set,
      'sec:Device',
      { serial: 'd1', risk: 'low', contactId: 'c1' },
      { ...data, 'db:Account': [account] },
    );
    const back = {
      all: [
        exists('crm:Contact.db:Account.ownerId'),
        { field: 'crm:Contact.db:Account.ownerId', operator: Operator.equals, value: 'u1' },
        exists('crm:Contact.db:Account.actor:User.id'),
        {
          field: 'crm:Contact.db:Account.actor:User.id',
          operator: Operator.equals,
          value: 'u1',
        },
      ],
    };
    expect(validateRule(back, { positive: true }).ok).toBe(true);
    expect(check(back, device)).toBe(true);
  });

  test('a read across any bridge needs exists on its exact leaf', () => {
    const risky = { field: 'crm:Contact.industry', operator: Operator.equals, value: 'tech' };
    expect(validateRule(risky, { positive: true }).errors.map((e) => e.code)).toEqual([
      'missingExists',
    ]);
    expect(
      validateRule({ all: [exists('crm:Contact'), risky] }, { positive: true }).errors.map(
        (e) => e.code,
      ),
    ).toEqual(['missingExists']);
  });

  test('the stitched lens reads the chain once each hop is turned on', () => {
    const lens = {
      parent: { ...stitchFieldMaps(set), mapName: 'db', model: 'Account' },
      root: {
        relations: { 'crm:Contact': { relations: { 'sec:Device': {} } }, 'actor:User': {} },
      },
    };
    const read = (field: string) =>
      validateRuleInLens({ field, operator: Operator.equals, value: 'x' }, lens).ok;
    expect(read('crm:Contact.industry')).toBe(true);
    expect(read('actor:User.id')).toBe(true);
    expect(read('crm:Contact.nope')).toBe(false);
  });
  test('a supplied row joins on: the actor reaches its devices, each a list of findings', () => {
    const owned = filled['actor:User'] as Record<string, unknown>;
    const devices = owned['sec:Device'] as Record<string, unknown>[];
    expect(devices.map((d) => d.serial)).toEqual(['d1', 'd3']);
    expect(devices.map((d) => (d['scan:Finding'] as { id: string }[]).map((f) => f.id))).toEqual([
      ['f1', 'f2'],
      ['f3'],
    ]);
    const actorHasCriticalFinding = {
      field: 'actor:User.sec:Device',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'scan:Finding',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'severity', operator: Operator.equals, value: 'critical' },
      },
    };
    expect(check(actorHasCriticalFinding, filled)).toBe(true);
  });

  test('data changed between calls is read as it is now', () => {
    const changing = { ...data, 'crm:Contact': [{ id: 'c1', industry: 'tech' }] };
    expect(
      (recordWithBridgeData(set, 'db:Account', account, changing)['crm:Contact'] as Row).industry,
    ).toBe('tech');
    changing['crm:Contact'] = [{ id: 'c1', industry: 'retail' }];
    expect(
      (recordWithBridgeData(set, 'db:Account', account, changing)['crm:Contact'] as Row).industry,
    ).toBe('retail');
  });

  test('the same device row is reached two ways, each filled on its own path', () => {
    const contact = filled['crm:Contact'] as Record<string, unknown>;
    const viaContact = (contact['sec:Device'] as Record<string, unknown>[])[0];
    expect((viaContact['scan:Finding'] as unknown[]).length).toBe(2);
    expect('crm:Contact' in viaContact).toBe(false);
  });

  test('a list of records is filled one by one, each with its own far rows', () => {
    const accounts = [
      { id: 'a1', ownerId: 'u1', crmId: 'c1' },
      { id: 'a2', ownerId: 'u2', crmId: 'c2' },
      { id: 'a3', ownerId: 'u3' },
    ].map((row) => recordWithBridgeData(set, 'db:Account', row, data));
    expect(accounts.map((a) => (a['crm:Contact'] as { id?: string } | undefined)?.id)).toEqual([
      'c1',
      'c2',
      undefined,
    ]);
    const techOwnedByActor = {
      all: [
        exists('ownerId'),
        exists('actor:User.id'),
        { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
        exists('crm:Contact.industry'),
        { field: 'crm:Contact.industry', operator: Operator.equals, value: 'tech' },
      ],
    };
    expect(accounts.map((a) => check(techOwnedByActor, a) === true)).toEqual([true, false, false]);
  });
});
