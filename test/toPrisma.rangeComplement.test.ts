import { describe, expect, it } from 'bun:test';
import { toPrisma } from '../index';
import { getWhere } from './fixtures/helpers';

// Prisma has no field-level negation of a two-sided range. It distributes `not` over the keys of
// the nested filter, so `{ col: { not: { gte: a, lte: b } } }` asks for
// `NOT(col >= a) AND NOT(col <= b)` — unsatisfiable for any window. The query validates and runs,
// and returns NOTHING: the failure is silent, so a segment over `notBetween` / `notWithin` reports
// an empty audience while check() answers correctly on the same rule. The complement therefore has
// to negate the whole clause, `{ NOT: { col: { gte: a, lte: b } } }`, which is also what toSql has
// always emitted (`NOT BETWEEN`).
const map = {
  models: {
    User: {
      fields: {
        score: { kind: 'scalar', type: 'Int', isRequired: true },
        nullableScore: { kind: 'scalar', type: 'Int', isRequired: false },
        eventDate: { kind: 'scalar', type: 'DateTime', isRequired: true },
        lastLoginAt: { kind: 'scalar', type: 'DateTime', isRequired: false },
      },
    },
  },
} as never;

const NOW = new Date('2026-08-25T00:00:00Z');
const opts = { map, model: 'User', now: NOW };
const WINDOW_START = new Date('2026-07-26T00:00:00.000Z');

describe('toPrisma — a range complement negates the clause, not the column filter', () => {
  it('notBetween (scalar) on a required column', () => {
    expect(
      getWhere(toPrisma({ field: 'score', operator: 'notBetween', value: [0, 10] } as never, opts)),
    ).toEqual({
      NOT: { score: { gte: 0, lte: 10 } },
    });
  });

  it('notBetween (scalar) on a nullable column keeps the null arm outside the NOT', () => {
    expect(
      getWhere(
        toPrisma({ field: 'nullableScore', operator: 'notBetween', value: [0, 10] } as never, opts),
      ),
    ).toEqual({
      OR: [{ NOT: { nullableScore: { gte: 0, lte: 10 } } }, { nullableScore: { equals: null } }],
    });
  });

  it('notWithin on a required column', () => {
    expect(
      getWhere(
        toPrisma(
          { field: 'eventDate', dateOperator: 'notWithin', value: { ago: { days: 30 } } } as never,
          opts,
        ),
      ),
    ).toEqual({ NOT: { eventDate: { gte: WINDOW_START, lte: NOW } } });
  });

  it('notWithin on a nullable column keeps the null arm outside the NOT', () => {
    expect(
      getWhere(
        toPrisma(
          {
            field: 'lastLoginAt',
            dateOperator: 'notWithin',
            value: { ago: { days: 30 } },
          } as never,
          opts,
        ),
      ),
    ).toEqual({
      OR: [
        { NOT: { lastLoginAt: { gte: WINDOW_START, lte: NOW } } },
        { lastLoginAt: { equals: null } },
      ],
    });
  });

  it('notBetween (date) negates the clause too', () => {
    expect(
      getWhere(
        toPrisma(
          {
            field: 'lastLoginAt',
            dateOperator: 'notBetween',
            value: ['2026-01-01', '2026-02-01'],
          } as never,
          opts,
        ),
      ),
    ).toEqual({
      OR: [
        {
          NOT: {
            lastLoginAt: {
              gte: new Date('2026-01-01T00:00:00.000Z'),
              lte: new Date('2026-02-01T00:00:00.000Z'),
            },
          },
        },
        { lastLoginAt: { equals: null } },
      ],
    });
  });

  // A compiled where alternates two kinds of node: CLAUSE nodes, whose keys are `NOT`/`AND`/`OR`
  // or column names, and FIELD FILTERS, whose keys are Prisma operators (`gte`, `in`, `not`, …).
  // The invariant is about the second kind, so the walk has to know which it is standing on —
  // stripping every key named `NOT` before looking would delete the defect and then assert its
  // absence. Column filters are collected here and asserted below.
  const CLAUSE_KEYS = new Set(['NOT', 'AND', 'OR']);
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

  const columnFilters = (clause: unknown): unknown[] => {
    if (!isPlainObject(clause)) return [];
    return Object.entries(clause).flatMap(([key, value]) =>
      CLAUSE_KEYS.has(key)
        ? (Array.isArray(value) ? value : [value]).flatMap(columnFilters)
        : // A column's own filter. Relation filters (some/every/none) nest another clause inside
          // it, so descend through those too rather than treating them as leaves.
          [
            value,
            ...['some', 'every', 'none', 'is', 'isNot'].flatMap((k) =>
              isPlainObject(value) ? columnFilters(value[k]) : [],
            ),
          ],
    );
  };

  it('no column filter any negated operator emits carries a clause-level NOT or a nested `not`', () => {
    const rules = [
      { field: 'score', operator: 'notBetween', value: [0, 10] },
      { field: 'nullableScore', operator: 'notBetween', value: [0, 10] },
      { field: 'score', operator: 'notEquals', value: 7 },
      { field: 'score', operator: 'notIn', value: [1, 2] },
      { field: 'eventDate', dateOperator: 'notWithin', value: { ago: { days: 30 } } },
      { field: 'lastLoginAt', dateOperator: 'notWithin', value: { ago: { days: 30 } } },
      { field: 'lastLoginAt', dateOperator: 'notBetween', value: ['2026-01-01', '2026-02-01'] },
      { field: 'lastLoginAt', dateOperator: 'notBefore', value: '2026-01-01' },
      { field: 'lastLoginAt', dateOperator: 'notAfter', value: '2026-01-01' },
    ];

    for (const rule of rules) {
      const filters = columnFilters(getWhere(toPrisma(rule as never, opts)));
      // Sanity: the walk must actually have reached something, or the assertions below are vacuous.
      expect(filters.length).toBeGreaterThan(0);
      for (const filter of filters) {
        if (!isPlainObject(filter)) continue;
        // Prisma rejects this outright.
        expect(Object.keys(filter)).not.toContain('NOT');
        // And this is the silent form: `not` is fine over a scalar (`notEquals` -> `{ not: 7 }`,
        // `exists` -> `{ not: null }`), but over a nested filter Prisma distributes it per key,
        // so a bounded range becomes unsatisfiable and matches nothing.
        expect(isPlainObject(filter.not)).toBe(false);
      }
    }
  });
});
