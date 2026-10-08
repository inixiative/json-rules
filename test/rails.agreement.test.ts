import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { narrowRule } from '../index';
import { agree, map, openRails, type Rails } from './rails/harness';

// check(), toSql on Postgres and toPrisma on Prisma agree on every rule they all compile.
// Fixture (test/rails/harness.ts): users 1–5; 2 has a DB-NULL meta and no tags, 5 a JSON-null
// meta; 4 and 5 have no org; 3's org has a NULL name.

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

const rule = (r: object): Condition => r as Condition;
const expectRails = async (r: object, expected: Rails, options?: object) =>
  expect(await rails.run(rule(r), options)).toEqual(expected);

describe('an absent to-one relation reads as NULL', () => {
  test('equals null', () =>
    expectRails({ field: 'org.name', operator: 'equals', value: null }, agree([3, 4, 5])));
  test('in with null', () =>
    expectRails({ field: 'org.name', operator: 'in', value: [null, 'Acme'] }, agree([1, 3, 4, 5])));
  test('notIn null', () =>
    expectRails({ field: 'org.name', operator: 'notIn', value: [null] }, agree([1, 2])));
  test('equals a path that reads through an absent relation', async () => {
    const rails3 = await rails.run(
      rule({ field: 'org.name', operator: 'equals', path: '$.org.parent.name' }),
    );
    expect(rails3.check).toEqual([4, 5]);
    expect(rails3.sql).toEqual([4, 5]);
  });
});

describe('a string operator with nothing to compare against', () => {
  const missing = { context: {} };
  for (const operator of ['contains', 'startsWith', 'endsWith'])
    test(operator, () =>
      expectRails({ field: 'name', operator, path: 'missing' }, agree([]), missing),
    );
  test('notContains keeps the NULL fields only', () =>
    expectRails({ field: 'name', operator: 'notContains', path: 'missing' }, agree([3]), missing));
});

describe('Json columns and paths', () => {
  test('a sub-path negation keeps absent and null paths', () =>
    expectRails({ field: 'meta.a.b', operator: 'notEquals', value: 'x' }, agree([2, 3, 4, 5])));
  test('an ordered comparison is numeric', () =>
    expectRails({ field: 'meta.n', operator: 'greaterThan', value: 25 }, agree([])));
  test('in', () => expectRails({ field: 'meta.n', operator: 'in', value: [3] }, agree([1])));
  test('notIn keeps absent paths', () =>
    expectRails({ field: 'meta.n', operator: 'notIn', value: [3] }, agree([2, 3, 4, 5])));
  test('contains', () =>
    expectRails({ field: 'meta.a.b', operator: 'contains', value: 'x' }, agree([1])));
  test('startsWith, case-insensitive', () =>
    expectRails(
      { field: 'meta.a.b', operator: 'startsWith', value: 'x', caseInsensitive: true },
      agree([1, 4]),
    ));
  test('a JSON null column does not exist', () =>
    expectRails({ field: 'meta', operator: 'exists' }, agree([1, 3, 4])));
  test('notExists matches DB NULL and JSON null', () =>
    expectRails({ field: 'meta', operator: 'notExists' }, agree([2, 5])));
  test('notExists at a path', () =>
    expectRails({ field: 'meta.a.b', operator: 'notExists' }, agree([2, 3, 5])));
});

describe('arrays', () => {
  test('an absent Json array is empty', () =>
    expectRails({ field: 'meta.list', arrayOperator: 'empty' }, agree([2, 3, 4, 5])));
  test('notEmpty Json array', () =>
    expectRails({ field: 'meta.list', arrayOperator: 'notEmpty' }, agree([1])));
  test('an empty scalar list is empty', () =>
    expectRails({ field: 'tags', arrayOperator: 'empty' }, agree([2, 3, 5])));
  test('notEmpty scalar list', () =>
    expectRails({ field: 'tags', arrayOperator: 'notEmpty' }, agree([1, 4])));
  test('a scalar list contains a member', () =>
    expectRails({ field: 'tags', operator: 'contains', value: 'a' }, agree([1])));
  test('notContains keeps an empty list', () =>
    expectRails({ field: 'tags', operator: 'notContains', value: 'a' }, agree([2, 3, 4, 5])));
});

describe('caseInsensitive applies to text', () => {
  test('ignored on an Int column', () =>
    expectRails({ field: 'age', operator: 'equals', value: 5, caseInsensitive: true }, agree([3])));
});

describe('relation aggregates skip NULL items', () => {
  test('sum', async () => {
    const result = await rails.run(
      rule({
        field: 'posts',
        aggregate: { mode: 'sum', field: 'views' },
        operator: 'lessThan',
        value: 5,
      }),
    );
    expect(result.check).toEqual([2, 3, 4, 5]);
    expect(result.prisma).toEqual([2, 3, 4, 5]);
  });
});

describe('a to-many hop in a plain field path is an array rule', () => {
  test('the compilers refuse it', async () => {
    const result = await rails.run(
      rule({ field: 'posts.title', operator: 'equals', value: 'hello' }),
    );
    expect(result.sql).toStartWith('throws: ');
    expect(result.prisma).toStartWith('throws: ');
    expect(result.sql).toContain('arrayOperator');
  });
});

// The matrix: every rule family, the ids each rail returns, and the rails that refuse a rule they
// have no form for. Users: 1 Ann (org Acme, posts 10 + 5 views, created 2026-10-05 10:00Z, a
// Monday), 2 bob (org acme → Acme, no posts), 3 (no name; org without a name; one post with NULL
// views), 4 Dee (no org, created 2025), 5 'nullable' (no org).
type Case = {
  rule: object;
  ids: number[];
  options?: object;
  refuses?: { sql?: string; prisma?: string };
};

const RELATION_ARRAYS = 'relation arrays are not supported in SQL';
const RELATION_AGGREGATES = 'cannot aggregate relation lists';
const NO_COLUMN_COMPARE = 'no column-to-column comparison';
const NO_WEEKDAY = 'has no Prisma form';
const NY = { timeZone: 'America/New_York' };
const NOT_FOR_ENUMS = 'does not apply to the enum';

const MATRIX: Record<string, Case> = {
  'date before': {
    rule: { field: 'createdAt', dateOperator: 'before', value: '2026-10-05T00:00:00Z' },
    ids: [3, 4],
  },
  'date onOrAfter a zoneless day in New York': {
    rule: { field: 'createdAt', dateOperator: 'onOrAfter', value: '2026-10-05' },
    ids: [1],
    options: NY,
  },
  'date within ago': {
    rule: { field: 'createdAt', dateOperator: 'within', value: { ago: { days: 2 } } },
    ids: [1, 3],
  },
  'date within this month in New York': {
    rule: { field: 'createdAt', dateOperator: 'within', value: { this: 'month' } },
    ids: [1, 3],
    options: NY,
  },
  'date notWithin keeps NULL': {
    rule: { field: 'createdAt', dateOperator: 'notWithin', value: { ago: { days: 2 } } },
    ids: [2, 4, 5],
  },
  'date between': {
    rule: { field: 'createdAt', dateOperator: 'between', value: ['2026-10-01', '2026-10-05'] },
    ids: [3],
  },
  'date notBetween keeps NULL': {
    rule: { field: 'createdAt', dateOperator: 'notBetween', value: ['2026-10-01', '2026-10-05'] },
    ids: [1, 2, 4, 5],
  },
  weekday: {
    rule: { field: 'createdAt', dateOperator: 'dayIn', value: ['monday'] },
    ids: [1],
    refuses: { prisma: NO_WEEKDAY },
  },
  'weekday in New York': {
    rule: { field: 'createdAt', dateOperator: 'dayIn', value: ['sunday'] },
    ids: [3],
    options: NY,
    refuses: { prisma: NO_WEEKDAY },
  },
  'weekday negation keeps NULL': {
    rule: { field: 'createdAt', dateOperator: 'dayNotIn', value: ['monday'] },
    ids: [2, 3, 4, 5],
    refuses: { prisma: NO_WEEKDAY },
  },
  'date against a related column': {
    rule: { field: 'createdAt', dateOperator: 'after', path: '$.org.foundedAt' },
    ids: [1],
    refuses: { prisma: NO_COLUMN_COMPARE },
  },
  'date negation against a related column keeps NULL': {
    rule: { field: 'createdAt', dateOperator: 'notBefore', path: '$.org.foundedAt' },
    ids: [1, 2, 5],
    refuses: { prisma: NO_COLUMN_COMPARE },
  },
  'date before an amount read per row': {
    rule: {
      field: 'createdAt',
      dateOperator: 'before',
      value: { ago: { days: { path: '$.age' } } },
    },
    ids: [4],
    refuses: { prisma: NO_COLUMN_COMPARE },
  },
  'date with an offset': {
    rule: {
      field: 'createdAt',
      dateOperator: 'before',
      value: '2026-10-06T00:00:00Z',
      offset: { value: { ago: { days: 1 } } },
    },
    ids: [3, 4],
  },
  'a DateTime field rule without coerceType': {
    rule: { field: 'createdAt', operator: 'greaterThan', value: '2026-10-05T00:00:00Z' },
    ids: [1],
  },
  'a related date': {
    rule: { field: 'org.foundedAt', dateOperator: 'before', value: '2026-01-01' },
    ids: [1],
  },
  'number between': { rule: { field: 'age', operator: 'between', value: [5, 30] }, ids: [1, 3, 5] },
  'number notBetween keeps NULL': {
    rule: { field: 'age', operator: 'notBetween', value: [5, 30] },
    ids: [2, 4],
  },
  'number with an offset': {
    rule: { field: 'age', operator: 'greaterThan', value: 20, offset: { value: 5 } },
    ids: [1, 4],
  },
  'number against a column with an offset': {
    rule: { field: 'age', operator: 'greaterThan', path: '$.score', offset: { value: 1 } },
    ids: [1, 3, 4],
    refuses: { prisma: NO_COLUMN_COMPARE },
  },
  'in, case-insensitive': {
    rule: { field: 'name', operator: 'in', value: ['ANN', 'dee'], caseInsensitive: true },
    ids: [1, 4],
  },
  'endsWith, case-insensitive': {
    rule: { field: 'name', operator: 'endsWith', value: 'E', caseInsensitive: true },
    ids: [4, 5],
  },
  'a related negation keeps an absent relation': {
    rule: { field: 'org.parent.plan', operator: 'notEquals', value: 'pro' },
    ids: [1, 3, 4, 5],
  },
  'a related Json path': {
    rule: { field: 'org.settings.limit', operator: 'greaterThanEquals', value: 7 },
    ids: [1],
  },
  'a Json path between': {
    rule: { field: 'meta.n', operator: 'between', value: [1, 5] },
    ids: [1],
  },
  'a Json path equals, case-insensitive': {
    rule: { field: 'meta.a.b', operator: 'equals', value: 'X', caseInsensitive: true },
    ids: [1, 4],
  },
  'a Json path notContains keeps absent paths': {
    rule: { field: 'meta.a.b', operator: 'notContains', value: 'x' },
    ids: [2, 3, 4, 5],
    refuses: { prisma: 'has no Prisma form' },
  },
  'a list exists': { rule: { field: 'tags', operator: 'exists' }, ids: [1, 2, 3, 4, 5] },
  'a list equals a list': {
    rule: { field: 'tags', operator: 'equals', value: ['a', 'b'] },
    ids: [1],
  },
  'a list notEquals keeps the others': {
    rule: { field: 'tags', operator: 'notEquals', value: ['a', 'b'] },
    ids: [2, 3, 4, 5],
  },
  'a required relation exists wherever its row does': {
    rule: {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'author', operator: 'exists' },
    },
    ids: [1, 3],
    refuses: { sql: 'relation arrays are not supported' },
  },
  'a required relation is never missing': {
    rule: {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'author', operator: 'notExists' },
    },
    ids: [],
    refuses: { sql: 'relation arrays are not supported' },
  },
  'a required relation past an optional hop': {
    rule: {
      field: 'org.users',
      arrayOperator: 'any',
      condition: { field: 'org', operator: 'exists' },
    },
    ids: [1, 2, 3],
    refuses: { sql: 'relation arrays are not supported' },
  },
  'a required column always exists': {
    rule: { field: 'id', operator: 'exists' },
    ids: [1, 2, 3, 4, 5],
  },
  'a required column is never missing': { rule: { field: 'id', operator: 'notExists' }, ids: [] },
  'a required column through a relation exists where its row does': {
    rule: {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'authorId', operator: 'exists' },
    },
    ids: [1, 3],
    refuses: { sql: 'relation arrays are not supported' },
  },
  'a required column past an optional to-one is missing where the hop is': {
    rule: { field: 'org.id', operator: 'notExists' },
    ids: [4, 5],
  },
  'a list in a set of lists': {
    rule: { field: 'tags', operator: 'in', value: [['a', 'b'], []] },
    ids: [1, 2, 3, 5],
  },
  'a list notIn a set of lists': {
    rule: { field: 'tags', operator: 'notIn', value: [['a', 'b']] },
    ids: [2, 3, 4, 5],
  },
  'a list equals one holding null': {
    rule: { field: 'tags', operator: 'equals', value: [null] },
    ids: [],
    refuses: { prisma: 'has no Prisma form' },
  },
  'a list notIn a set holding a null-bearing list': {
    rule: { field: 'tags', operator: 'notIn', value: [[null], ['a', 'b']] },
    ids: [2, 3, 4, 5],
    refuses: { prisma: 'has no Prisma form' },
  },
  'a list is never in a set of strings': {
    rule: { field: 'tags', operator: 'in', value: ['a', null] },
    ids: [],
  },
  'an enum equals, case-insensitive': {
    rule: { field: 'role', operator: 'equals', value: 'ADMIN', caseInsensitive: true },
    ids: [1],
  },
  'a string operator does not apply to an enum': {
    rule: { field: 'role', operator: 'contains', value: 'm' },
    ids: [1, 4],
    refuses: { sql: NOT_FOR_ENUMS, prisma: NOT_FOR_ENUMS },
  },
  'an ordered comparison does not apply to an enum': {
    rule: { field: 'role', operator: 'lessThan', value: 'b' },
    ids: [1, 3],
    refuses: { sql: NOT_FOR_ENUMS, prisma: NOT_FOR_ENUMS },
  },
  'an enum in': {
    rule: { field: 'role', operator: 'in', value: ['member', 'Guest'] },
    ids: [3, 4],
  },
  'an enum notIn, case-insensitive': {
    rule: { field: 'role', operator: 'notIn', value: ['MEMBER'], caseInsensitive: true },
    ids: [1, 2, 3, 5],
  },
  'a pattern does not apply to an enum': {
    rule: { field: 'role', operator: 'matches', value: '^m' },
    ids: [4],
    refuses: { sql: NOT_FOR_ENUMS, prisma: NOT_FOR_ENUMS },
  },
  'a string literal on a number column is refused, not cast': {
    rule: { field: 'age', operator: 'equals', value: '30' },
    ids: [],
    refuses: { sql: 'the literal is a string', prisma: 'the literal is a string' },
  },
  'contains reads % and _ literally': {
    rule: { field: 'name', operator: 'contains', value: '%' },
    ids: [],
  },
  'startsWith reads _ literally': {
    rule: { field: 'name', operator: 'startsWith', value: '_' },
    ids: [],
  },
  'a Json string reads % literally': {
    rule: { field: 'meta.a.b', operator: 'contains', value: '%' },
    ids: [],
  },
  'an implication whose if ends with': {
    rule: {
      if: { field: 'name', operator: 'endsWith', value: 'n' },
      then: { field: 'age', operator: 'greaterThan', value: 100 },
    },
    ids: [2, 3, 4, 5],
  },
  'a relation all over startsWith': {
    rule: {
      field: 'posts',
      arrayOperator: 'all',
      condition: { field: 'title', operator: 'startsWith', value: 'h' },
    },
    ids: [2, 4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'notStartsWith keeps NULL': {
    rule: { field: 'name', operator: 'notStartsWith', value: 'b' },
    ids: [1, 3, 4, 5],
  },
  'notEndsWith, case-insensitive': {
    rule: { field: 'name', operator: 'notEndsWith', value: 'E', caseInsensitive: true },
    ids: [1, 2, 3],
  },
  'notStartsWith on a Json path keeps other types; Prisma has no form': {
    rule: { field: 'meta.a.b', operator: 'notStartsWith', value: 'x' },
    ids: [2, 3, 4, 5],
    refuses: { prisma: 'has no Prisma form' },
  },
  'matches, case-insensitive': {
    rule: { field: 'name', operator: 'matches', value: /^d/i },
    ids: [4],
    refuses: { prisma: 'has no Prisma form' },
  },
  'an enum value the enum does not declare matches nothing': {
    rule: { field: 'role', operator: 'in', value: ['admin', 'superuser'] },
    ids: [1],
  },
  'notEquals an undeclared enum value keeps every row': {
    rule: { field: 'role', operator: 'notEquals', value: 'superuser' },
    ids: [1, 2, 3, 4, 5],
  },
  'a list contains, case-insensitive': {
    rule: { field: 'tags', operator: 'contains', value: 'A', caseInsensitive: true },
    ids: [1],
    refuses: { prisma: 'no Prisma form' },
  },
  'a list notContains, case-insensitive': {
    rule: { field: 'tags', operator: 'notContains', value: 'C', caseInsensitive: true },
    ids: [1, 2, 3, 5],
    refuses: { prisma: 'no Prisma form' },
  },
  'a list equals, case-insensitive': {
    rule: { field: 'tags', operator: 'equals', value: ['A', 'B'], caseInsensitive: true },
    ids: [1],
    refuses: { prisma: 'no Prisma form' },
  },
  'a list isEmpty': { rule: { field: 'tags', operator: 'isEmpty' }, ids: [2, 3, 5] },
  'a list notEmpty': { rule: { field: 'tags', operator: 'notEmpty' }, ids: [1, 4] },
  'a relation exists': { rule: { field: 'org', operator: 'exists' }, ids: [1, 2, 3] },
  'a relation notExists': { rule: { field: 'org.parent', operator: 'notExists' }, ids: [1, 4, 5] },
  'an implication with an else': {
    rule: {
      if: { field: 'org', operator: 'exists' },
      then: { field: 'org.plan', operator: 'equals', value: 'pro' },
      else: { field: 'age', operator: 'greaterThan', value: 30 },
    },
    ids: [1, 4],
  },
  'any of all': {
    rule: {
      any: [
        {
          all: [
            { field: 'age', operator: 'lessThan', value: 10 },
            { field: 'name', operator: 'exists' },
          ],
        },
        { field: 'org.plan', operator: 'isEmpty' },
      ],
    },
    ids: [2, 4, 5],
  },
  'relation any': {
    rule: {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'title', operator: 'equals', value: 'hello' },
    },
    ids: [1],
    refuses: { sql: RELATION_ARRAYS },
  },
  'relation all fails a NULL child': {
    rule: {
      field: 'posts',
      arrayOperator: 'all',
      condition: { field: 'views', operator: 'greaterThan', value: 6 },
    },
    ids: [2, 4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'relation none': {
    rule: {
      field: 'posts',
      arrayOperator: 'none',
      condition: { field: 'title', operator: 'equals', value: null },
    },
    ids: [2, 3, 4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'relation empty': {
    rule: { field: 'posts', arrayOperator: 'empty' },
    ids: [2, 4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'relation atLeast': {
    rule: { field: 'posts', arrayOperator: 'atLeast', count: 2, condition: true },
    ids: [1],
    refuses: { sql: RELATION_ARRAYS },
  },
  'relation exactly 0 keeps the childless': {
    rule: {
      field: 'posts',
      arrayOperator: 'exactly',
      count: 0,
      condition: { field: 'views', operator: 'greaterThan', value: 6 },
    },
    ids: [2, 3, 4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'a nested relation any': {
    rule: {
      field: 'org.users',
      arrayOperator: 'any',
      condition: { field: 'name', operator: 'equals', value: 'Ann' },
    },
    ids: [1],
    refuses: { sql: RELATION_ARRAYS },
  },
  'all under an absent relation holds': {
    rule: {
      field: 'org.users',
      arrayOperator: 'all',
      condition: { field: 'age', operator: 'greaterThan', value: 10 },
    },
    ids: [1, 4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'empty under an absent relation': {
    rule: { field: 'org.users', arrayOperator: 'empty' },
    ids: [4, 5],
    refuses: { sql: RELATION_ARRAYS },
  },
  'a Json array under an absent relation is empty': {
    rule: { field: 'org.settings.nums', arrayOperator: 'empty' },
    ids: [2, 3, 4, 5],
  },
  'an aggregate under an absent relation is 0': {
    rule: {
      field: 'org.users',
      aggregate: { mode: 'avg', field: 'age' },
      operator: 'lessThan',
      value: 20,
    },
    ids: [2, 3, 4, 5],
    refuses: { sql: RELATION_AGGREGATES },
  },
  'the top of a window is its largest value, NULLs last': {
    rule: {
      field: 'posts',
      arrayOperator: 'any',
      orderBy: [{ field: 'views', dir: 'desc' }],
      take: 1,
      condition: { field: 'views', operator: 'greaterThan', value: 6 },
    },
    ids: [1],
    refuses: { sql: 'Windowing' },
  },
  'the bottom of a window is its smallest value, NULLs last': {
    rule: {
      field: 'posts',
      arrayOperator: 'all',
      orderBy: [{ field: 'views', dir: 'asc' }],
      take: 1,
      condition: { field: 'views', operator: 'greaterThanEquals', value: 5 },
    },
    ids: [1, 2, 4, 5],
    refuses: { sql: 'Windowing' },
  },
  'relation avg': {
    rule: {
      field: 'posts',
      aggregate: { mode: 'avg', field: 'views' },
      operator: 'greaterThanEquals',
      value: 5,
    },
    ids: [1],
    refuses: { sql: RELATION_AGGREGATES },
  },
  'Json array sum': {
    rule: { field: 'meta.list', aggregate: { mode: 'sum' }, operator: 'greaterThan', value: 1 },
    ids: [1],
    refuses: { prisma: 'require aggregate.field' },
  },
  'Json array avg of nothing is 0': {
    rule: { field: 'meta.list', aggregate: { mode: 'avg' }, operator: 'equals', value: 0 },
    ids: [2, 3, 4, 5],
    refuses: { prisma: 'require aggregate.field' },
  },
};

describe('the rule matrix', () => {
  for (const [name, { rule: r, ids, options, refuses = {} }] of Object.entries(MATRIX))
    test(name, async () => {
      const result = await rails.run(rule(r), options);
      expect(result.check).toEqual(ids);
      for (const rail of ['sql', 'prisma'] as const) {
        const refusal = refuses[rail];
        if (refusal) expect(result[rail]).toContain(refusal);
        else expect(result[rail]).toEqual(ids);
      }
    });
});

describe('a narrowed array rule compiles on Prisma', () => {
  // The grant reads only posts with views; narrowRule puts it in the rule's window filter.
  const lens = { maps: { app: map }, mapName: 'app', model: 'User' };
  const narrowing = {
    parent: lens,
    root: { relations: { posts: { where: { field: 'views', operator: 'exists' } } } },
  };
  const narrowed = (r: object) => narrowRule(rule(r), narrowing as never);

  test('all over the granted posts', async () => {
    const result = await rails.run(
      narrowed({
        field: 'posts',
        arrayOperator: 'all',
        condition: { field: 'title', operator: 'equals', value: 'hello' },
      }),
    );
    expect(result.check).toEqual([2, 3, 4, 5]);
    expect(result.prisma).toEqual([2, 3, 4, 5]);
  });

  test('any and atLeast over the granted posts', async () => {
    const any = await rails.run(
      narrowed({
        field: 'posts',
        arrayOperator: 'any',
        condition: { field: 'title', operator: 'equals', value: 'Hi' },
      }),
    );
    expect(any.check).toEqual([]);
    expect(any.prisma).toEqual([]);
    const two = await rails.run(
      narrowed({ field: 'posts', arrayOperator: 'atLeast', count: 2, condition: true }),
    );
    expect(two.check).toEqual([1]);
    expect(two.prisma).toEqual([1]);
  });
});
