import { describe, expect, it } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { getWhere } from './fixtures/helpers';

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

describe('toPrisma if/then with bridge antecedent (over-approximation contract)', () => {
  it('bridge `if`, no else → must over-fetch (not silently drop the antecedent)', () => {
    // `if` hits a bridge → buildCondition returns {}. The implication
    // `(NOT if) OR then` then becomes `(NOT {}) OR then`. Prisma evaluates
    // `NOT: {}` as match-nothing, so the OR collapses to `then`. That
    // *under-fetches*: rows where if=false (which the rule trivially passes)
    // are filtered out. Over-fetch contract says we must keep them.
    const result = toPrisma(
      {
        if: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
        then: { field: 'tier', operator: Operator.equals, value: 'gold' },
      },
      opts,
    );
    // Either match-everything ({}) or drops the if-clause entirely. What's
    // NOT acceptable is a clause that filters by `then` alone, which is what
    // `{ NOT: {} }` collapses to in Prisma.
    expect(getWhere(result)).toEqual({});
  });

  it('bridge `if` with else → both branches must remain reachable', () => {
    // Without short-circuit: AND[ OR[NOT {}, then], OR[{}, else] ]
    // = AND[ then, match-all ] = then. The else branch is silently dropped.
    const result = toPrisma(
      {
        if: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
        then: { field: 'tier', operator: Operator.equals, value: 'gold' },
        else: { field: 'tier', operator: Operator.equals, value: 'silver' },
      },
      opts,
    );
    expect(getWhere(result)).toEqual({});
  });

  it('bridge in `then` (not if) → over-fetch the whole if/then', () => {
    // Without guard on `then`: OR[NOT(if), {}] = match-all is over-fetch (safe). But
    // with an `else` branch, AND[OR[NOT(if), {}], OR[if, else]] degenerates and silently
    // drops the `then` branch. Easier to over-fetch the whole expression than reason
    // about which OR positions are safe.
    const result = toPrisma(
      {
        if: { field: 'tier', operator: Operator.equals, value: 'gold' },
        then: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      },
      opts,
    );
    expect(getWhere(result)).toEqual({});
  });

  it('bridge in `else` (not if) → over-fetch the whole if/then/else', () => {
    // The bug: AND[OR[NOT(if), then], OR[if, {}]] = AND[OR[NOT(if), then], match-all]
    // = OR[NOT(if), then]. Semantics are the implication-without-else form, silently
    // dropping the else branch. Records satisfying `if` but failing `then` pass when
    // they should fall to else.
    const result = toPrisma(
      {
        if: { field: 'tier', operator: Operator.equals, value: 'gold' },
        then: { field: 'email', operator: Operator.contains, value: '@vip.com' },
        else: { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      },
      opts,
    );
    expect(getWhere(result)).toEqual({});
  });

  it('non-bridge if/then is unchanged (regression guard)', () => {
    const result = toPrisma(
      {
        if: { field: 'tier', operator: Operator.equals, value: 'gold' },
        then: { field: 'email', operator: Operator.contains, value: '@' },
      },
      opts,
    );
    expect(getWhere(result)).toEqual({
      OR: [{ NOT: { tier: { equals: 'gold' } } }, { email: { contains: '@' } }],
    });
  });
});
