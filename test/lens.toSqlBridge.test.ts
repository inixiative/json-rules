import { describe, expect, test } from 'bun:test';
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
    },
  },
};

const salesforceMap: FieldMap = {
  Contact: {
    fields: { industry: { kind: 'scalar', type: 'String' } },
  },
};

const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact' },
    { fieldMap: 'prisma', model: 'FanUser' },
  ],
  cardinality: 'oneToMany',
};

const stitched = stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [bridge]);

describe('toSql bridge handling', () => {
  test('standalone bridge predicate compiles to TRUE', () => {
    const result = toSql(
      { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      { map: stitched.prisma, model: 'FanUser' },
    );
    expect(result.sql).toContain('TRUE');
  });

  test('AND with bridge: bridge slot is TRUE', () => {
    const result = toSql(
      {
        all: [
          { field: 'email', operator: Operator.equals, value: 'x' },
          { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
        ],
      },
      { map: stitched.prisma, model: 'FanUser' },
    );
    expect(result.sql).toContain('TRUE');
    expect(result.sql.toLowerCase()).toContain('email');
  });
});
