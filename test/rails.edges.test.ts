import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { agree, openRails, type Rails } from './rails/harness';

// Values that read differently in a careless compile: LIKE metacharacters, strings inside Json
// arrays. Users 20–23.
const SEED = `
INSERT INTO users (id, name, meta, tags) VALUES
  (20, 'a%b', '{"s":"a%b","list":["A","b"]}', '{}'),
  (21, 'a_b', '{"s":"a_b","list":["X"]}', '{}'),
  (22, 'a\\b', '{"s":"a\\\\b"}', '{}'),
  (23, 'A%B', '{"s":"A%B","list":["a"]}', '{}');
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
      agree([1, 2, 3, 4, 5, 20, 22, 23]),
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
      refusedOnPrisma([1, 2, 3, 4, 5, 20, 22, 23]),
    ));
  test('a backslash on a Json path', () =>
    expectRails(
      { field: 'meta.s', operator: 'equals', value: 'a\\b', caseInsensitive: true },
      refusedOnPrisma([22]),
    ));
  test('a Json value with no LIKE syntax compiles', () =>
    expectRails(
      { field: 'meta.s', operator: 'equals', value: 'a%b', caseInsensitive: false },
      agree([20]),
    ));
});
