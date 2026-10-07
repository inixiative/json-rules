import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { openRails, type Rails } from './rails/harness';

// Json values compare as JSON: by value and never across types. Users 6–9 add typed values:
// 6 meta { n: "3", a: { b: "" }, list: "x" }, 7 { n: true, a: { b: ["x"] } }, 8 meta [],
// 9 meta "" (base users: 1 { a: { b: "x" }, n: 3, list: [1,2,3] }, 2 NULL, 3 { a: null, n: null,
// list: [] }, 4 { a: { b: "X" } }, 5 JSON null).
const SEED = `
INSERT INTO users (id, name, meta, tags) VALUES
  (6, 'Fay', '{"n":"3","a":{"b":""},"list":"x"}', '{A}'),
  (7, 'Gus', '{"n":true,"a":{"b":["x"]}}', '{a,""}'),
  (8, 'Hal', '[]', '{}'),
  (9, 'Ivy', '""', '{}');
`;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(SEED);
});
afterAll(async () => {
  await rails.close();
});

const agree = (ids: number[]): Rails => ({ check: ids, sql: ids, prisma: ids });
const cases: Record<string, [object, number[]]> = {
  'a number equals a number, not its string': [
    { field: 'meta.n', operator: 'equals', value: 3 },
    [1],
  ],
  'a string equals a string, not a number': [
    { field: 'meta.n', operator: 'equals', value: '3' },
    [6],
  ],
  'a boolean equals a boolean': [{ field: 'meta.n', operator: 'equals', value: true }, [7]],
  'notEquals keeps every other value and the absent': [
    { field: 'meta.n', operator: 'notEquals', value: 3 },
    [2, 3, 4, 5, 6, 7, 8, 9],
  ],
  'in compares by type': [{ field: 'meta.n', operator: 'in', value: ['3', true] }, [6, 7]],
  'notIn compares by type': [
    { field: 'meta.n', operator: 'notIn', value: [3] },
    [2, 3, 4, 5, 6, 7, 8, 9],
  ],
  'an ordered comparison against a number skips strings': [
    { field: 'meta.n', operator: 'greaterThan', value: 1 },
    [1],
  ],
  'an ordered comparison against a string skips numbers': [
    { field: 'meta.n', operator: 'lessThan', value: '4' },
    [6],
  ],
  'between compares within a type': [{ field: 'meta.n', operator: 'between', value: [1, 5] }, [1]],
  'startsWith reads strings': [{ field: 'meta.n', operator: 'startsWith', value: '3' }, [6]],
  'contains on a string, or membership in an array': [
    { field: 'meta.a.b', operator: 'contains', value: 'x' },
    [1, 7],
  ],
  'endsWith "" matches strings only': [
    { field: 'meta.a.b', operator: 'endsWith', value: '' },
    [1, 4, 6],
  ],
  'an array equals an array': [{ field: 'meta.list', operator: 'equals', value: [1, 2, 3] }, [1]],
  'an object equals an object': [{ field: 'meta.a', operator: 'equals', value: { b: 'x' } }, [1]],
  'a whole column equals a string': [{ field: 'meta', operator: 'equals', value: '' }, [9]],
  'a whole column is empty as null, "" or []': [
    { field: 'meta', operator: 'isEmpty' },
    [2, 5, 8, 9],
  ],
};

describe('Json values compare as JSON', () => {
  test('notBetween keeps the other types; Prisma has no form for it', async () => {
    const result = await rails.run({
      field: 'meta.n',
      operator: 'notBetween',
      value: [1, 5],
    } as Condition);
    expect(result.check).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.sql).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.prisma).toContain('has no Prisma form');
  });

  for (const [name, [rule, ids]] of Object.entries(cases))
    test(name, async () => {
      expect(await rails.run(rule as Condition)).toEqual(agree(ids));
    });
});
