import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { buildBridgeIndex } from '../src/fieldMap/buildBridgeIndex';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge, FieldMapSet } from '../src/fieldMap/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Three sources, two bridges deep:
//   prisma:FanUser  --(1-1)--  salesforce:Contact  --(1-1)--  billing:Account
//
// Rule needs to walk: FanUser → Contact → Account → field
const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      crmId: { kind: 'scalar', type: 'String' },
    },
  },
};

const salesforceMap: FieldMap = {
  Contact: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      industry: { kind: 'scalar', type: 'String' },
      accountId: { kind: 'scalar', type: 'String' },
    },
  },
};

const billingMap: FieldMap = {
  Account: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      plan: { kind: 'scalar', type: 'String' },
      monthlySpend: { kind: 'scalar', type: 'Int' },
    },
  },
};

const fanUserToContact: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToOne',
};

const contactToAccount: Bridge = {
  endpoints: [
    { fieldMap: 'billing', model: 'Account', on: 'id' },
    { fieldMap: 'salesforce', model: 'Contact', on: 'accountId' },
  ],
  cardinality: 'oneToOne',
};

const set: FieldMapSet = {
  maps: { prisma: prismaMap, salesforce: salesforceMap, billing: billingMap },
  bridges: [fanUserToContact, contactToAccount],
};

describe('3-source / 2-bridge-deep traversal', () => {
  test('stitching produces bridge fields on each endpoint model', () => {
    const stitched = stitchFieldMaps(set);
    expect(stitched.maps.prisma.FanUser.fields['salesforce:Contact']).toBeDefined();
    expect(stitched.maps.salesforce.Contact.fields['prisma:FanUser']).toBeDefined();
    expect(stitched.maps.salesforce.Contact.fields['billing:Account']).toBeDefined();
    expect(stitched.maps.billing.Account.fields['salesforce:Contact']).toBeDefined();
  });

  test('check walks rule across two bridges', () => {
    // Build per-row data manually (mimics what the caller would do with buildBridgeIndex)
    const account = { id: 'a1', plan: 'enterprise', monthlySpend: 5000 };
    const contact = {
      id: 'c1',
      industry: 'tech',
      accountId: 'a1',
      'billing:Account': account,
    };
    const fanUser = {
      id: 'u1',
      email: 'a@b.com',
      crmId: 'c1',
      'salesforce:Contact': contact,
    };

    const rule = {
      all: [
        { field: 'email', operator: Operator.equals, value: 'a@b.com' },
        {
          field: 'salesforce:Contact.industry',
          operator: Operator.equals,
          value: 'tech',
        },
        {
          field: 'salesforce:Contact.billing:Account.plan',
          operator: Operator.equals,
          value: 'enterprise',
        },
      ],
    };
    expect(check(rule, fanUser)).toBe(true);
  });

  test('check fails when terminal field at depth-2 mismatches', () => {
    const account = { id: 'a1', plan: 'free', monthlySpend: 0 };
    const contact = {
      id: 'c1',
      industry: 'tech',
      accountId: 'a1',
      'billing:Account': account,
    };
    const fanUser = {
      id: 'u1',
      crmId: 'c1',
      'salesforce:Contact': contact,
    };

    expect(
      typeof check(
        {
          field: 'salesforce:Contact.billing:Account.plan',
          operator: Operator.equals,
          value: 'enterprise',
        },
        fanUser,
      ),
    ).toBe('string');
  });

  test('buildBridgeIndex (multi-bridge) → caller composes per-row → check passes deep', () => {
    const index = buildBridgeIndex(set, {
      'salesforce:Contact': [
        { id: 'c1', industry: 'tech', accountId: 'a1' },
        { id: 'c2', industry: 'finance', accountId: 'a2' },
      ],
      'billing:Account': [
        { id: 'a1', plan: 'enterprise' },
        { id: 'a2', plan: 'free' },
      ],
    });

    // Contact has two views: by id (from FanUser side) and by accountId (from Account side)
    expect(index.salesforce.Contact.id.c1).toBeDefined();
    expect(index.salesforce.Contact.accountId.a1).toBeDefined();
    expect(index.billing.Account.id.a1).toBeDefined();

    // Caller assembles per-row: FanUser → Contact → Account
    const fanUser = { id: 'u1', crmId: 'c1' };
    const contact = index.salesforce.Contact.id[fanUser.crmId] as Record<string, unknown>;
    const account = index.billing.Account.id[contact.accountId as string];
    const enriched = {
      ...fanUser,
      'salesforce:Contact': { ...contact, 'billing:Account': account },
    };

    const rule = {
      field: 'salesforce:Contact.billing:Account.plan',
      operator: Operator.equals,
      value: 'enterprise',
    };
    expect(check(rule, enriched)).toBe(true);
  });
});
