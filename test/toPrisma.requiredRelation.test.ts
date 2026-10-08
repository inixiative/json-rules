import { describe, expect, test } from 'bun:test';
import { type FieldMap, toPrisma } from '../index';
import { getWhere } from './fixtures/helpers';

// A required relation is present whenever its row is, so its existence compiles through the
// optional hops above it — but only when every hop says whether it is required.
const map = (bRequired?: boolean): FieldMap => ({
  models: {
    A: {
      fields: {
        b: {
          kind: 'object',
          type: 'B',
          ...(bRequired === undefined ? {} : { isRequired: bRequired }),
        },
      },
    },
    B: { fields: { c: { kind: 'object', type: 'C', isRequired: true } } },
    C: { fields: { id: { kind: 'scalar', type: 'String' } } },
  },
});
const where = (operator: 'exists' | 'notExists', bRequired?: boolean) =>
  getWhere(toPrisma({ field: 'b.c', operator }, { map: map(bRequired), model: 'A' }));

describe('existence of a required relation', () => {
  test('under required hops it always holds', () => {
    expect(where('exists', true)).toEqual({});
    expect(where('notExists', true)).toEqual({ OR: [] });
  });

  test('under an optional hop it is missing exactly where the hop is', () => {
    expect(where('exists', false)).toEqual({ NOT: { b: { is: null } } });
    expect(where('notExists', false)).toEqual({ b: { is: null } });
  });

  test('under a hop of unknown requiredness it keeps the relation filter', () => {
    expect(where('exists')).toEqual({ b: { c: { isNot: null } } });
    expect(where('notExists')).toEqual({ b: { c: { is: null } } });
  });
});
