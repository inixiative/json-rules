import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { agree, openRails, type Rails } from './rails/harness';

// Values that read differently in a careless compile: LIKE metacharacters, strings inside Json
// arrays, patterns RE2 and Postgres read differently. Users 20–27.
const SEED = `
INSERT INTO users (id, name, meta, tags) VALUES
  (20, 'a%b', '{"s":"a%b","list":["A","b"]}', '{}'),
  (21, 'a_b', '{"s":"a_b","list":["X"]}', '{}'),
  (22, 'a\\b', '{"s":"a\\\\b"}', '{}'),
  (23, 'A%B', '{"s":"A%B","list":["a"]}', '{}'),
  (24, 'foo bar', '{"s":"foo bar"}', '{}'),
  (25, E'line1\\nline2', '{"s":"line1\\nline2"}', '{}'),
  (26, 'ÄBC', '{"s":"ÄBC"}', '{}'),
  (27, 'AB7', '{"s":"AB7"}', '{}');
`;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(SEED);
});
afterAll(async () => {
  await rails.close();
});

const expectRails = async (r: object, expected: Rails) =>
  expect(await rails.run(r as Condition)).toEqual(expected);

describe('a case-insensitive equality matches only its own value', () => {
  test('equals', () =>
    expectRails(
      { field: 'name', operator: 'equals', value: 'A%B', caseInsensitive: true },
      agree([20, 23]),
    ));
  test('notEquals keeps everything else', () =>
    expectRails(
      { field: 'name', operator: 'notEquals', value: 'A_B', caseInsensitive: true },
      agree([1, 2, 3, 4, 5, 20, 22, 23, 24, 25, 26, 27]),
    ));
  // Prisma matches Json against its JSON text, where an escape is itself escaped: it refuses.
  const refusedOnPrisma = (ids: number[]) => ({
    check: ids,
    sql: ids,
    prisma: expect.stringContaining('has no Prisma form') as unknown as `throws: ${string}`,
  });
  test('in on a Json path', () =>
    expectRails(
      { field: 'meta.s', operator: 'in', value: ['A%B'], caseInsensitive: true },
      refusedOnPrisma([20, 23]),
    ));
  test('notIn on a Json path', () =>
    expectRails(
      { field: 'meta.s', operator: 'notIn', value: ['A_B'], caseInsensitive: true },
      refusedOnPrisma([1, 2, 3, 4, 5, 20, 22, 23, 24, 25, 26, 27]),
    ));
  test('a backslash on a Json path', () =>
    expectRails(
      { field: 'meta.s', operator: 'equals', value: 'a\\b', caseInsensitive: true },
      refusedOnPrisma([22]),
    ));
  test.each([
    'A"B',
    'LINE1\nLINE2',
    'tab\tx',
  ])('a quote or control character on a Json path: %j', (value) =>
    expectRails(
      { field: 'meta.s', operator: 'equals', value, caseInsensitive: true },
      refusedOnPrisma(value === 'LINE1\nLINE2' ? [25] : []),
    ));
  test('a Json value with no LIKE syntax compiles', () =>
    expectRails(
      { field: 'meta.s', operator: 'equals', value: 'a%b', caseInsensitive: false },
      agree([20]),
    ));
});

describe('contains on Json: a string holds a string, an array holds a member', () => {
  const refusedOnPrisma = (ids: number[]) => ({
    check: ids,
    sql: ids,
    prisma: expect.stringContaining('has no Prisma form') as unknown as `throws: ${string}`,
  });
  test('a case-insensitive member', () =>
    expectRails(
      { field: 'meta.list', operator: 'contains', value: 'a', caseInsensitive: true },
      refusedOnPrisma([20, 23]),
    ));
  test('a case-insensitive member, negated', () =>
    expectRails(
      { field: 'meta.list', operator: 'notContains', value: 'x', caseInsensitive: true },
      {
        check: [1, 2, 3, 4, 5, 20, 22, 23, 24, 25, 26, 27],
        sql: [1, 2, 3, 4, 5, 20, 22, 23, 24, 25, 26, 27],
        prisma: expect.stringContaining('no Prisma form') as unknown as `throws: ${string}`,
      },
    ));
  test('a number is a member, never a substring', () =>
    expectRails({ field: 'meta.list', operator: 'contains', value: 1 }, agree([1])));
  test('a number never reads inside a string', () =>
    expectRails({ field: 'meta.s', operator: 'contains', value: 1 }, agree([])));
});

describe('a pattern matches on Postgres what it matches on RE2', () => {
  const both = async (field: string, value: string, ids?: number[]) => {
    const result = await rails.run({ field, operator: 'matches', value } as Condition);
    expect(result.sql).toEqual(result.check);
    if (ids) expect(result.check).toEqual(ids);
    return result.check as number[];
  };
  // A class reads ASCII only: 'ÄBC' (26) is outside it on both engines.
  const ascii = async (field: string, value: string) =>
    expect(await both(field, value)).not.toContain(26);
  for (const field of ['name', 'meta.s'])
    describe(field, () => {
      test('\\b is a word boundary', () => both(field, '\\bbar', [24]));
      test('\\B is not one', () => both(field, 'o\\Bo', [24]));
      test('. stops at a newline', () => both(field, '^line1.line2$', []));
      test('\\w is ASCII', () => ascii(field, '^\\w+$'));
      test('[[:alpha:]] is ASCII', () => ascii(field, '^[[:alpha:]]+$'));
      test('\\x41 is one character', () => both(field, '^\\x41B7$', [27]));
      test('an octal escape is a character, not a backreference', () =>
        both(field, '^\\101B', [27]));
      test('\\Q…\\E quotes', () => both(field, '\\Qa%b\\E', [20]));
      test('a named group', () => both(field, '(?P<w>foo) ', [24]));
      test('\\z ends the text', () => both(field, 'line2\\z', [25]));
      test.each([
        '^[\\s-z]+$',
        '[\\w-z]',
        '[\\d-z]',
        '[[:alpha:]-z]',
        '[%-[:digit:]]',
        '^a{01}b$',
      ])('a - beside a class, a zero-led count: %s', (pattern) => both(field, pattern));
    });

  test.each([
    ['a Unicode class', '\\pL'],
    ['a flag group', '(?i)foo'],
    ['a repeat past 255', 'a{300}'],
  ])('%s is refused on SQL, matched by check()', async (_, value) => {
    const result = await rails.run({ field: 'name', operator: 'matches', value } as Condition);
    expect(result.check).not.toEqual(expect.stringContaining('throws'));
    expect(result.sql).toEqual(expect.stringContaining('has no Postgres form'));
  });
});

test('a date rule on a String column has no Prisma form', async () => {
  const result = await rails.run({
    field: 'name',
    dateOperator: 'before',
    value: '2026-10-03',
  } as Condition);
  expect(result.prisma).toEqual(expect.stringContaining('the String field'));
});
