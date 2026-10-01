import { describe, expect, test } from 'bun:test';
import { Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import type { Rule } from '../src/types';
import { getWhere } from './fixtures/helpers';

// A field operator on a DateTime column used to pass its literal through as written. Prisma
// accepts only a Date or a zoned ISO-8601 instant, so a day-only string, a zoneless ISO string
// and an epoch-ms number all threw at query time ("Expected ISO-8601 DateTime" / "Expected
// DateTime, provided Int") while the lens gate and check() accepted them. The literal now
// compiles through check()'s own DateTime coercion to a Date.
const map: FieldMap = {
  models: {
    Event: {
      fields: {
        name: { kind: 'scalar', type: 'String' },
        count: { kind: 'scalar', type: 'Int' },
        createdAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
        meta: { kind: 'scalar', type: 'Json' },
        account: { kind: 'object', type: 'Account' },
      },
    },
    Account: {
      fields: {
        syncedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};
const opts = { map, model: 'Event' };
const at = (iso: string) => new Date(iso);

describe('toPrisma — DateTime field-operator literals compile to Dates', () => {
  test('day-only, zoneless ISO, zoned ISO, epoch ms, epoch-ms string and Date', () => {
    const cases: [unknown, string][] = [
      ['2026-09-01', '2026-09-01T00:00:00.000Z'],
      ['2026-09-01T10:00:00', '2026-09-01T10:00:00.000Z'],
      ['2026-09-01 10:00', '2026-09-01T10:00:00.000Z'],
      ['2026-09-01T10:00:00+02:00', '2026-09-01T08:00:00.000Z'],
      [1_790_000_000_000, new Date(1_790_000_000_000).toISOString()],
      ['1790000000000', new Date(1_790_000_000_000).toISOString()],
      [at('2026-09-01T10:00:00Z'), '2026-09-01T10:00:00.000Z'],
    ];
    for (const [value, iso] of cases) {
      const where = getWhere(
        toPrisma({ field: 'createdAt', operator: Operator.greaterThan, value } as Rule, opts),
      );
      expect(where).toEqual({ createdAt: { gt: at(iso) } });
    }
  });

  test('in / between convert element-wise and keep null', () => {
    expect(
      getWhere(
        toPrisma({ field: 'createdAt', operator: Operator.in, value: ['2026-09-01', null] }, opts),
      ),
    ).toEqual({
      OR: [{ createdAt: { in: [at('2026-09-01T00:00:00Z')] } }, { createdAt: { equals: null } }],
    });
    expect(
      getWhere(
        toPrisma(
          { field: 'createdAt', operator: Operator.between, value: ['2026-09-30', '2026-09-01'] },
          opts,
        ),
      ),
    ).toEqual({
      createdAt: { gte: at('2026-09-01T00:00:00Z'), lte: at('2026-09-30T00:00:00Z') },
    });
  });

  test('equals null stays null', () => {
    expect(
      getWhere(toPrisma({ field: 'createdAt', operator: Operator.equals, value: null }, opts)),
    ).toEqual({ createdAt: { equals: null } });
  });

  test('a DateTime across a relation converts too', () => {
    expect(
      getWhere(
        toPrisma(
          { field: 'account.syncedAt', operator: Operator.lessThan, value: '2026-09-01' },
          opts,
        ),
      ),
    ).toEqual({ account: { syncedAt: { lt: at('2026-09-01T00:00:00Z') } } });
  });

  test('a context path value converts', () => {
    expect(
      getWhere(
        toPrisma(
          { field: 'createdAt', operator: Operator.greaterThan, path: 'since' },
          { ...opts, context: { since: '2026-09-01' } },
        ),
      ),
    ).toEqual({ createdAt: { gt: at('2026-09-01T00:00:00Z') } });
  });

  test('without a map, a stamped DateTime coerceType converts', () => {
    expect(
      getWhere(
        toPrisma({
          field: 'createdAt',
          operator: Operator.greaterThan,
          value: '2026-09-01',
          coerceType: 'DateTime',
        }),
      ),
    ).toEqual({ createdAt: { gt: at('2026-09-01T00:00:00Z') } });
  });

  test('an unparseable literal throws at compile time', () => {
    expect(() =>
      toPrisma({ field: 'createdAt', operator: Operator.equals, value: 'not-a-date' }, opts),
    ).toThrow("Invalid date value for DateTime field 'createdAt': not-a-date");
  });

  test('non-DateTime columns and Json paths pass literals through', () => {
    expect(
      getWhere(toPrisma({ field: 'name', operator: Operator.equals, value: '2026-09-01' }, opts)),
    ).toEqual({ name: { equals: '2026-09-01' } });
    expect(
      getWhere(
        toPrisma({ field: 'meta.at', operator: Operator.equals, value: '2026-09-01' }, opts),
      ),
    ).toEqual({ meta: { path: ['at'], equals: '2026-09-01' } });
  });
});

describe('toPrisma — a coerceType that overrides the column kind throws', () => {
  test('String column coerced to Int', () => {
    expect(() =>
      toPrisma(
        { field: 'name', operator: Operator.greaterThan, value: 5, coerceType: 'Int' },
        opts,
      ),
    ).toThrow(
      "coerceType 'Int' overrides String field 'name', but toPrisma compares the column as stored",
    );
  });

  test('a stamp equal to the column kind compiles', () => {
    expect(
      getWhere(
        toPrisma({ field: 'count', operator: Operator.equals, value: 3, coerceType: 'Int' }, opts),
      ),
    ).toEqual({ count: { equals: 3 } });
  });

  test('a coerceType below a Json boundary compiles — the map declares no kind there', () => {
    expect(
      getWhere(
        toPrisma(
          { field: 'meta.n', operator: Operator.greaterThan, value: 5, coerceType: 'Int' },
          opts,
        ),
      ),
    ).toEqual({ meta: { path: ['n'], gt: 5 } });
  });
});
