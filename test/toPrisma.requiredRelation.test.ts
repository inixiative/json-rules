import { describe, expect, test } from 'bun:test';
import { type FieldMap, toPrisma } from '../index';
import { getWhere } from './fixtures/helpers';

// A relation's existence is `is: {}`: present where it and every hop above it are, with no
// `null` filter Prisma rejects on a required relation and no requiredness to know.
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

describe('existence of a relation compiles without null, required or not', () => {
  for (const bRequired of [true, false, undefined])
    test(`under a hop whose requiredness is ${String(bRequired)}`, () => {
      expect(where('exists', bRequired)).toEqual({ b: { c: { is: {} } } });
      expect(where('notExists', bRequired)).toEqual({ NOT: { b: { c: { is: {} } } } });
    });
});
