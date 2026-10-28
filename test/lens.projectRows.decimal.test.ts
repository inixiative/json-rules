import { describe, expect, test } from 'bun:test';
import { check, type FieldMap, type Lens, type LensNarrowing, projectRows } from '../index';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        balance: { kind: 'scalar', type: 'Decimal' },
        code: { kind: 'scalar', type: 'String' },
        rates: { kind: 'scalar', type: 'Decimal', isList: true },
        entries: { kind: 'object', type: 'Entry', isList: true },
      },
    },
    Entry: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        amount: { kind: 'scalar', type: 'Decimal' },
      },
    },
  },
};

const base: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };
const lens: LensNarrowing = { parent: base, root: { relations: { entries: {} } } };

// What Prisma hands back for a Decimal column: an object that converts with toNumber().
const decimal = (text: string) => ({ toNumber: () => Number(text), toString: () => text });

describe('projectRows reads a Decimal column as a number', () => {
  test('a Decimal.js-like object and a numeric string both come back numbers, at every depth', () => {
    const [row] = projectRows(lens, [
      {
        id: 'u1',
        balance: decimal('12.5'),
        code: '0042',
        rates: ['1.25', decimal('2')],
        entries: [{ id: 'e1', amount: '-3.75' }],
      },
    ]);
    expect(row).toEqual({
      id: 'u1',
      balance: 12.5,
      code: '0042',
      rates: [1.25, 2],
      entries: [{ id: 'e1', amount: -3.75 }],
    });
  });

  test('null and a non-numeric value pass through', () => {
    const [row] = projectRows(lens, [
      { id: 'u1', balance: null, entries: [{ id: 'e1', amount: 'n/a' }] },
    ]);
    expect(row).toEqual({ id: 'u1', balance: null, entries: [{ id: 'e1', amount: 'n/a' }] });
  });

  test('check compares the projected value as a number', () => {
    const [row] = projectRows(lens, [{ id: 'u1', balance: decimal('100.5'), entries: [] }]);
    expect(check({ field: 'balance', operator: 'greaterThan', value: 100 }, row!)).toBe(true);
  });
});
