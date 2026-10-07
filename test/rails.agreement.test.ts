import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { agree, openRails, type Rails } from './rails/harness';

// check(), toSql on Postgres and toPrisma on Prisma agree on every rule they all compile.
// Fixture (test/rails/harness.ts): users 1–5; 2 has a DB-NULL meta and tags, 5 a JSON-null
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
  test('a NULL scalar list is empty', () =>
    expectRails({ field: 'tags', arrayOperator: 'empty' }, agree([2, 3, 5])));
  test('notEmpty scalar list', () =>
    expectRails({ field: 'tags', arrayOperator: 'notEmpty' }, agree([1, 4])));
  test('a scalar list contains a member', () =>
    expectRails({ field: 'tags', operator: 'contains', value: 'a' }, agree([1])));
  test('notContains keeps a NULL list', () =>
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
