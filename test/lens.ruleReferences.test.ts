import { describe, expect, test } from 'bun:test';
import { ruleReferences } from '../src/lens/ruleReferences';
import { ruleSourceValues } from '../src/lens/ruleSourceValues';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
        accountUuid: { kind: 'scalar', type: 'String' },
        account: {
          kind: 'object',
          type: 'Account',
          fromFields: ['accountUuid'],
          toFields: ['uuid'],
        },
        orders: { kind: 'object', type: 'Order', isList: true, fromFields: [], toFields: [] },
        memberships: { kind: 'object', type: 'Membership', isList: true },
      },
    },
    Account: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
      },
    },
    Order: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        productUuid: { kind: 'scalar', type: 'String' },
        note: { kind: 'scalar', type: 'String' },
        product: {
          kind: 'object',
          type: 'Product',
          fromFields: ['productUuid'],
          toFields: ['uuid'],
        },
      },
    },
    Product: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
      },
    },
    Membership: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        groupUuid: { kind: 'scalar', type: 'String' },
        group: { kind: 'object', type: 'Group', fromFields: ['groupUuid'], toFields: ['uuid'] },
      },
    },
    Group: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
      },
    },
    Ticket: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        tenantUuid: { kind: 'scalar', type: 'String' },
        seatUuid: { kind: 'scalar', type: 'String' },
        seat: {
          kind: 'object',
          type: 'Seat',
          fromFields: ['tenantUuid', 'seatUuid'],
          toFields: ['tenantUuid', 'uuid'],
        },
      },
    },
    Seat: {
      fields: {
        uuid: { kind: 'scalar', type: 'String' },
        tenantUuid: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };

const narrowing: LensNarrowing = {
  parent: lens,
  root: {
    picks: ['tier', 'accountUuid', 'orders', 'memberships'],
    relations: {
      orders: { picks: ['productUuid', 'note'] },
      memberships: { relations: { group: { picks: ['uuid'] } } },
    },
  },
};

describe('ruleReferences — which rows a rule names', () => {
  test('a foreign key names a row of the model it points at', () => {
    const rule: Condition = {
      field: 'orders',
      arrayOperator: 'any',
      condition: { field: 'productUuid', operator: 'equals', value: 'P1' },
    };

    expect(ruleReferences(narrowing, rule)).toEqual([
      {
        path: 'User.orders',
        mapName: 'app',
        model: 'Order',
        field: 'productUuid',
        referencedModel: 'Product',
        values: ['P1'],
        dynamic: false,
      },
    ]);
  });

  test('an identity reached through a relation names a row of that model', () => {
    const rule: Condition = {
      field: 'memberships',
      arrayOperator: 'any',
      condition: { field: 'group.uuid', operator: 'in', value: ['G1', 'G2'] },
    };

    expect(ruleReferences(narrowing, rule)).toMatchObject([
      { model: 'Group', field: 'uuid', referencedModel: 'Group', values: ['G1', 'G2'] },
    ]);
  });

  // why: this is the whole reason the primitive is separate from ruleSourceValues — neither
  // why: field below is a declared source, so asking through sources returns nothing and the
  // why: caller would have to declare a vocabulary it never wanted fetched.
  test('a field needs no declared source to be a reference', () => {
    const rule: Condition = { field: 'accountUuid', operator: 'equals', value: 'A1' };

    expect(ruleReferences(narrowing, rule)).toMatchObject([
      { model: 'User', field: 'accountUuid', referencedModel: 'Account' },
    ]);
  });

  test('the same rule yields a reference but no source — the two questions are different', () => {
    const rule: Condition = { field: 'accountUuid', operator: 'equals', value: 'A1' };

    expect(ruleSourceValues(narrowing, rule)).toEqual([]);
    expect(ruleReferences(narrowing, rule)).toHaveLength(1);
  });

  test('a plain scalar names no row', () => {
    const rule: Condition = {
      field: 'orders',
      arrayOperator: 'any',
      condition: { field: 'note', operator: 'contains', value: 'urgent' },
    };

    expect(ruleReferences(narrowing, rule)).toEqual([]);
  });

  test('a non-enumerating operator marks the reference dynamic instead of inventing rows', () => {
    const rule: Condition = {
      field: 'orders',
      arrayOperator: 'any',
      condition: { field: 'productUuid', operator: 'contains', value: 'P' },
    };

    expect(ruleReferences(narrowing, rule)).toMatchObject([
      { referencedModel: 'Product', values: [], dynamic: true },
    ]);
  });

  test('a bind marks the reference dynamic — the row is named at evaluation, not here', () => {
    const rule: Condition = { field: 'accountUuid', operator: 'equals', bind: 'accountUuid' };

    expect(ruleReferences(narrowing, rule)).toMatchObject([
      { referencedModel: 'Account', values: [], dynamic: true },
    ]);
  });

  test('quantifier-blind: a `none` relation names its row as much as an `any` one', () => {
    const rule: Condition = {
      field: 'orders',
      arrayOperator: 'none',
      condition: { field: 'productUuid', operator: 'equals', value: 'P9' },
    };

    expect(ruleReferences(narrowing, rule)).toMatchObject([
      { referencedModel: 'Product', values: ['P9'] },
    ]);
  });

  test('a path the narrowing hides is silent', () => {
    const hidden: LensNarrowing = { parent: lens, root: { picks: ['tier'] } };
    const rule: Condition = { field: 'accountUuid', operator: 'equals', value: 'A1' };

    expect(ruleReferences(hidden, rule)).toEqual([]);
  });

  // why: one column of a two-column key identifies a set, not a record — reporting it would
  // why: hand the caller a uuid that names several rows and read as a resolvable reference.
  test('a composite key names no row', () => {
    const composite: Lens = { maps: { app: map }, mapName: 'app', model: 'Ticket' };
    const open: LensNarrowing = { parent: composite, root: { picks: ['tenantUuid', 'seatUuid'] } };

    expect(ruleReferences(open, { field: 'seatUuid', operator: 'equals', value: 'S1' })).toEqual(
      [],
    );
    expect(ruleReferences(open, { field: 'tenantUuid', operator: 'equals', value: 'T1' })).toEqual(
      [],
    );
  });

  test('the identity set comes from the map the leaf landed in, not the root map', () => {
    const otherMap: FieldMap = {
      models: {
        Invoice: {
          fields: {
            uuid: { kind: 'scalar', type: 'String' },
            payerUuid: { kind: 'scalar', type: 'String' },
            payer: { kind: 'object', type: 'Payer', fromFields: ['payerUuid'], toFields: ['uuid'] },
          },
        },
        Payer: { fields: { uuid: { kind: 'scalar', type: 'String' } } },
      },
    };
    const twoMaps: Lens = {
      maps: { app: map, billing: otherMap },
      mapName: 'billing',
      model: 'Invoice',
    };
    const open: LensNarrowing = { parent: twoMaps, root: { picks: ['payerUuid'] } };

    expect(
      ruleReferences(open, { field: 'payerUuid', operator: 'equals', value: 'X1' }),
    ).toMatchObject([
      { mapName: 'billing', model: 'Invoice', field: 'payerUuid', referencedModel: 'Payer' },
    ]);
  });

  test('dotted and nested spellings collapse to one reference', () => {
    const dotted: Condition = { field: 'orders.productUuid', operator: 'equals', value: 'P1' };
    const nested: Condition = {
      field: 'orders',
      arrayOperator: 'any',
      condition: { field: 'productUuid', operator: 'equals', value: 'P2' },
    };

    const both = ruleReferences(narrowing, { all: [dotted, nested] });

    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ referencedModel: 'Product', values: ['P1', 'P2'] });
  });
});
