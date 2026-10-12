import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { andWhere, executePrismaPlan, matchAll, matchNothing, orWhere, toPrisma } from '../index';
import { map, openRails } from './rails/harness';

// A consumer composes a compiled where with its own filters: a scope, a floor, a clamp.
// `{ OR: [] }` is match-nothing on its own, but as an arm of a hand-written `AND: [...]`
// Prisma drops it and the AND matches everything (measured: Prisma 7 + Postgres here,
// Prisma 6 + MySQL in zealot). andWhere / orWhere are the composition the compiler
// itself uses, exported so a consumer folds constants the same way.

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

const ids = async (where: object) =>
  (
    await rails.prisma.user.findMany({
      where: where as never,
      select: { id: true },
      orderBy: { id: 'asc' },
    })
  ).map((row) => row.id);

const compile = (rule: Condition) =>
  executePrismaPlan(toPrisma(rule, { map, model: 'User' }), rails.prisma as never) as Promise<
    Record<string, unknown>
  >;

const floor = { id: { gt: 0 } };

describe('composing a compiled where with a consumer filter', () => {
  test('a hand-written AND around a compiled false misreads (why andWhere exists)', async () => {
    const nothing = await compile(false as unknown as Condition);
    expect(nothing).toEqual(matchNothing());
    expect(await ids(nothing)).toEqual([]);
    expect(await ids({ AND: [floor, nothing] })).toEqual([1, 2, 3, 4, 5]);
  });

  test('andWhere: a compiled false absorbs the AND', async () => {
    const nothing = await compile({
      all: [{ field: 'age', operator: 'greaterThan', value: 1 }, false],
    } as never);
    expect(await ids(andWhere([floor, nothing]))).toEqual([]);
  });

  test('andWhere: a compiled true drops out', async () => {
    const all = await compile(true as unknown as Condition);
    expect(andWhere([floor, all])).toEqual(floor);
    expect(await ids(andWhere([floor, all]))).toEqual([1, 2, 3, 4, 5]);
  });

  test('andWhere of real filters is their intersection', async () => {
    const adults = await compile({ field: 'age', operator: 'greaterThan', value: 10 } as never);
    expect(await ids(andWhere([floor, adults]))).toEqual([1, 4]);
  });

  test('orWhere: a compiled false drops out, a compiled true absorbs', async () => {
    const nothing = await compile(false as unknown as Condition);
    const named = { name: { equals: 'Ann' } };
    expect(await ids(orWhere([named, nothing]))).toEqual([1]);
    expect(orWhere([named, matchAll()])).toEqual(matchAll());
  });
});
