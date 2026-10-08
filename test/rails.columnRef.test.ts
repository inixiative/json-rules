import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Condition, createLens, describeRule, toPrisma, validateRule } from '../index';
import { agree, map, openRails } from './rails/harness';

// A bare value `path` reads a column of the root row on every rail: check() reads the row, toSql
// compiles a column, toPrisma a Prisma field reference — only between columns of the same model
// at the same visit and of exactly the same type — and the rails agree, NULL rows included.

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  // User 6: age and orgId both NULL.
  rails = await openRails(`INSERT INTO users (id, tags) VALUES (6, '{}');`);
});
afterAll(async () => {
  await rails.close();
});

const rule = (r: object): Condition => r as Condition;

describe('a column compared with a column of the same model and type: three rails agree', () => {
  test.each<[string, Condition, number[]]>([
    ['greaterThan', rule({ field: 'age', operator: 'greaterThan', path: 'orgId' }), [1]],
    ['equals', rule({ field: 'age', operator: 'equals', path: 'orgId' }), [6]],
    // Equality is IS NOT DISTINCT FROM: a NULL against a value differs (users 2, 4, 5).
    ['notEquals', rule({ field: 'age', operator: 'notEquals', path: 'orgId' }), [1, 2, 3, 4, 5]],
    ['equals, two NULLs', rule({ field: 'orgId', operator: 'equals', path: 'age' }), [6]],
    [
      'lessThanEquals',
      rule({ field: 'id', operator: 'lessThanEquals', path: 'age' }),
      [1, 3, 4, 5],
    ],
    ['lessThan', rule({ field: 'id', operator: 'lessThan', path: '$.age' }), [1, 3, 4, 5]],
    [
      'greaterThanEquals',
      rule({ field: 'age', operator: 'greaterThanEquals', path: 'id' }),
      [1, 3, 4, 5],
    ],
    [
      'DateTime',
      rule({ field: 'createdAt', operator: 'lessThanEquals', path: 'createdAt' }),
      [1, 3, 4],
    ],
  ])('%s', async (_, r, ids) => {
    expect(await rails.run(r)).toEqual(agree(ids));
  });

  test('inside a relation filter, `$.` reads the element: check and Prisma agree', async () => {
    const r = rule({
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'views', operator: 'greaterThan', path: '$.authorId' },
    });
    const ran = await rails.run(r);
    expect(ran.check).toEqual([1]);
    expect(ran.prisma).toEqual([1]);
  });
});

describe('everything else throws on the Prisma rail, and says so before compiling', () => {
  const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
  const prismaOk = (r: Condition) =>
    describeRule(r, {
      parent: lens,
      root: { relations: { org: {}, posts: {} } },
    }).supportedTargets.includes('toPrisma');

  test.each<[string, Condition, RegExp]>([
    [
      'different types',
      rule({ field: 'age', operator: 'greaterThan', path: 'score' }),
      /same type/,
    ],
    ['enum vs String', rule({ field: 'role', operator: 'equals', path: 'name' }), /same type/],
    [
      'across a relation hop',
      rule({ field: 'age', operator: 'lessThan', path: 'org.seats' }),
      /not a column/,
    ],
    ['in', rule({ field: 'age', operator: 'in', path: 'orgId' }), /takes no column reference/],
    // Prisma reads the column as a LIKE pattern: its % and _ are wildcards.
    [
      'contains',
      rule({ field: 'name', operator: 'contains', path: 'name' }),
      /takes no column reference/,
    ],
    ['a list column', rule({ field: 'name', operator: 'equals', path: 'tags' }), /list column/],
    ['a Json column', rule({ field: 'name', operator: 'equals', path: 'meta' }), /Json column/],
    [
      'an offset',
      rule({ field: 'age', operator: 'greaterThan', path: 'orgId', offset: { value: 1 } }),
      /offset/,
    ],
    [
      'a bare path in a relation filter',
      rule({
        field: 'posts',
        arrayOperator: 'any',
        condition: { field: 'views', operator: 'greaterThan', path: 'age' },
      }),
      /root row/,
    ],
  ])('%s', async (_, r, why) => {
    expect(() => toPrisma(r, { map, model: 'User' })).toThrow(why);
    expect(validateRule(r, { target: 'toPrisma', map, model: 'User' }).ok).toBe(false);
    expect(prismaOk(r)).toBe(false);
  });

  test('a supported comparison stays a Prisma target', () => {
    const r = rule({ field: 'age', operator: 'greaterThan', path: 'orgId' });
    expect(validateRule(r, { target: 'toPrisma', map, model: 'User' }).ok).toBe(true);
    expect(prismaOk(r)).toBe(true);
    expect(validateRule(r, { target: 'toPrisma' }).ok).toBe(false);
  });

  test('the where carries a sentinel only executePrismaPlan resolves', () => {
    const r = rule({ field: 'age', operator: 'greaterThan', path: 'orgId' });
    expect(JSON.stringify(toPrisma(r, { map, model: 'User' }))).toContain(
      '"__field":{"model":"User","field":"orgId"}',
    );
  });
});
