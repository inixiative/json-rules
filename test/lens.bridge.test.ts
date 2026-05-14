import { describe, expect, test } from 'bun:test';
import { check, toPrisma } from '../index';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge, FieldMapSet } from '../src/fieldMap/types';
import type { Lens } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

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
    },
  },
};

const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact' },
    { fieldMap: 'prisma', model: 'FanUser' },
  ],
  cardinality: 'oneToMany',
};

const stitched: FieldMapSet = stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [
  bridge,
]);

const lens: Lens = {
  map: stitched,
  mapName: 'prisma',
  model: 'FanUser',
};

describe('lens + bridge: toPrisma compiles only the Prisma-pushable subset', () => {
  test('standalone bridge predicate compiles to {}', () => {
    const rule = {
      field: 'salesforce:Contact.industry',
      operator: Operator.equals,
      value: 'tech',
    };
    const result = toPrisma(rule, { ...lens });
    const where = result.steps[result.steps.length - 1];
    expect(where.operation).toBe('where');
    expect((where as { where: object }).where).toEqual({});
  });

  test('AND of prisma-pushable + bridge: bridge slot becomes {}', () => {
    const rule = {
      all: [
        { field: 'email', operator: Operator.equals, value: 'foo@bar.com' },
        { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      ],
    };
    const result = toPrisma(rule, { ...lens });
    const where = (result.steps[result.steps.length - 1] as unknown as { where: { AND: object[] } })
      .where;
    expect(where.AND).toEqual([{ email: { equals: 'foo@bar.com' } }, {}]);
  });

  test('OR of prisma-pushable + bridge: bridge slot becomes {} (over-fetch)', () => {
    const rule = {
      any: [
        { field: 'email', operator: Operator.equals, value: 'foo@bar.com' },
        { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      ],
    };
    const result = toPrisma(rule, { ...lens });
    const where = (result.steps[result.steps.length - 1] as unknown as { where: { OR: object[] } })
      .where;
    expect(where.OR).toEqual([{ email: { equals: 'foo@bar.com' } }, {}]);
  });
});

describe('lens + bridge: check() against pre-hydrated foreign data', () => {
  test('full AND evaluates both predicates correctly', () => {
    const rule = {
      all: [
        { field: 'email', operator: Operator.equals, value: 'foo@bar.com' },
        { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      ],
    };

    const matching = {
      email: 'foo@bar.com',
      'salesforce:Contact': { industry: 'tech' },
    };
    expect(check(rule, matching)).toBe(true);

    const wrongEmail = {
      email: 'wrong@bar.com',
      'salesforce:Contact': { industry: 'tech' },
    };
    expect(typeof check(rule, wrongEmail)).toBe('string');

    const wrongIndustry = {
      email: 'foo@bar.com',
      'salesforce:Contact': { industry: 'finance' },
    };
    expect(typeof check(rule, wrongIndustry)).toBe('string');
  });

  test('OR evaluates either side', () => {
    const rule = {
      any: [
        { field: 'email', operator: Operator.equals, value: 'foo@bar.com' },
        { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      ],
    };

    expect(check(rule, { email: 'foo@bar.com', 'salesforce:Contact': { industry: 'x' } })).toBe(
      true,
    );
    expect(check(rule, { email: 'x@x.com', 'salesforce:Contact': { industry: 'tech' } })).toBe(
      true,
    );
    expect(typeof check(rule, { email: 'x@x.com', 'salesforce:Contact': { industry: 'x' } })).toBe(
      'string',
    );
  });
});
