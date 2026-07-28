import { describe, expect, test } from 'bun:test';
import { Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { getWhere } from './fixtures/helpers';

// isEmpty/notEmpty used to emit the `equals: ''` branch for EVERY column kind.
// Prisma rejects '' on non-String columns outright ("Invalid value for argument
// `equals`: premature end of input. Expected ISO-8601 DateTime."), so an authored
// `sourceUpdatedAt isEmpty` was a guaranteed runtime 500. The ''-branch belongs to
// String (and Json) columns only; everything typed compiles to a pure null check.
const map: FieldMap = {
  models: {
    Enrichment: {
      fields: {
        value: { kind: 'scalar', type: 'String' },
        sourceUpdatedAt: { kind: 'scalar', type: 'DateTime' },
        score: { kind: 'scalar', type: 'Int' },
        metadata: { kind: 'scalar', type: 'Json' },
        status: { kind: 'enum', type: 'Status', values: ['active', 'paused'] },
        integrationMap: {
          kind: 'object',
          type: 'IntegrationMap',
        },
      },
    },
    IntegrationMap: {
      fields: {
        syncedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
  enums: { Status: ['active', 'paused'] },
};
const opts = { map, model: 'Enrichment' };

describe('toPrisma isEmpty/notEmpty — the ""-branch is String-only', () => {
  test('String keeps the null-or-empty-string OR', () => {
    const where = getWhere(toPrisma({ field: 'value', operator: Operator.isEmpty }, opts));
    expect(where).toEqual({ OR: [{ value: { equals: null } }, { value: { equals: '' } }] });
  });

  test('DateTime compiles to a pure null check', () => {
    const where = getWhere(
      toPrisma({ field: 'sourceUpdatedAt', operator: Operator.isEmpty }, opts),
    );
    expect(where).toEqual({ sourceUpdatedAt: { equals: null } });
  });

  test('DateTime notEmpty compiles to a pure not-null check', () => {
    const where = getWhere(
      toPrisma({ field: 'sourceUpdatedAt', operator: Operator.notEmpty }, opts),
    );
    expect(where).toEqual({ sourceUpdatedAt: { not: null } });
  });

  test('Int and enum columns drop the ""-branch too', () => {
    expect(getWhere(toPrisma({ field: 'score', operator: Operator.isEmpty }, opts))).toEqual({
      score: { equals: null },
    });
    expect(getWhere(toPrisma({ field: 'status', operator: Operator.isEmpty }, opts))).toEqual({
      status: { equals: null },
    });
  });

  test('Json keeps the two-branch shape ("" is a representable JSON value)', () => {
    const where = getWhere(toPrisma({ field: 'metadata', operator: Operator.isEmpty }, opts));
    expect(where).toEqual({ OR: [{ metadata: { equals: null } }, { metadata: { equals: '' } }] });
  });

  test('a to-one relation path resolves the LEAF column type', () => {
    const where = getWhere(
      toPrisma({ field: 'integrationMap.syncedAt', operator: Operator.isEmpty }, opts),
    );
    expect(where).toEqual({ integrationMap: { syncedAt: { equals: null } } });
  });

  test('without a map, a stamped coerceType decides', () => {
    const where = getWhere(
      toPrisma({ field: 'sourceUpdatedAt', operator: Operator.isEmpty, coerceType: 'DateTime' }),
    );
    expect(where).toEqual({ sourceUpdatedAt: { equals: null } });
  });

  test('with no type information at all, the legacy two-branch shape survives', () => {
    const where = getWhere(toPrisma({ field: 'anything', operator: Operator.isEmpty }));
    expect(where).toEqual({ OR: [{ anything: { equals: null } }, { anything: { equals: '' } }] });
  });
});
