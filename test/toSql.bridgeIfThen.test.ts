import { describe, expect, it } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';

const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      crmId: { kind: 'scalar', type: 'String' },
      tier: { kind: 'scalar', type: 'String' },
    },
  },
};
const salesforceMap: FieldMap = {
  Contact: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      industry: { kind: 'scalar', type: 'String' },
    },
  },
};
const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToOne',
};
const stitched = stitchFieldMaps({
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges: [bridge],
});
const opts = { map: stitched.maps.prisma, model: 'FanUser' };

describe('toSql if/then with bridge sub-clause must over-fetch', () => {
  // Bridge predicates compile to 'TRUE'. In `(NOT(TRUE) OR then)` = `(FALSE OR then) = then`,
  // which is an UNDER-fetch (drops rows where if=false-in-reality and then=false). Same
  // semantic corruption as the Prisma side fixed in 2.0.1. The whole expression should
  // emit TRUE so the caller's check() filters precisely.
  it('bridge in `if` (no else) → TRUE (over-fetch)', () => {
    const result = toSql(
      {
        if: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
        then: { field: 'tier', operator: Operator.equals, value: 'gold' },
      },
      opts,
    );
    expect(result.sql.trim()).toBe('TRUE');
  });

  it('bridge in `if` with else → TRUE', () => {
    const result = toSql(
      {
        if: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
        then: { field: 'tier', operator: Operator.equals, value: 'gold' },
        else: { field: 'tier', operator: Operator.equals, value: 'silver' },
      },
      opts,
    );
    expect(result.sql.trim()).toBe('TRUE');
  });

  it('bridge in `then` (not if) → TRUE', () => {
    const result = toSql(
      {
        if: { field: 'tier', operator: Operator.equals, value: 'gold' },
        then: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      },
      opts,
    );
    expect(result.sql.trim()).toBe('TRUE');
  });

  it('bridge in `else` (not if) → TRUE', () => {
    const result = toSql(
      {
        if: { field: 'tier', operator: Operator.equals, value: 'gold' },
        then: { field: 'email', operator: Operator.contains, value: '@vip.com' },
        else: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      },
      opts,
    );
    expect(result.sql.trim()).toBe('TRUE');
  });

  it('non-bridge if/then unchanged (regression guard)', () => {
    const result = toSql(
      {
        if: { field: 'tier', operator: Operator.equals, value: 'gold' },
        then: { field: 'email', operator: Operator.contains, value: '@' },
      },
      opts,
    );
    // Should be the standard NOT(if) OR then form
    expect(result.sql).toContain('NOT');
    expect(result.sql.toLowerCase()).toContain('tier');
    expect(result.sql.toLowerCase()).toContain('email');
  });
});
