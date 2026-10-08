import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  check,
  createLens,
  executePrismaPlan,
  type LensNarrowing,
  materializeSources,
  projectRows,
  toLensSelect,
  toPrisma,
  UsageError,
} from '../index';
import { map, openRails } from './rails/harness';

// The release-gate polish of 3.4 (round 12): misuse is the caller's, and says so.

const rule = (r: object): Condition => r as Condition;
const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const thrown = (run: () => unknown): Error | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error;
  }
};

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(
    `INSERT INTO orgs (id, name, plan) VALUES (15, 'R', 'free'); INSERT INTO users (id, name, tags, "orgId") VALUES (9, 'nine', '{}', 15);`,
  );
});
afterAll(async () => {
  await rails.close();
});

describe('R12-1: rows a viewer projection nulled are refused, not read as absent', () => {
  const free = rule({ field: 'plan', operator: 'notEquals', value: 'free' });
  const fetch = async (lens: LensNarrowing) => {
    const where = await executePrismaPlan(toPrisma(true, { lens }), rails.prisma as never);
    return (await rails.prisma.user.findMany({
      where: where as never,
      select: toLensSelect(lens).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];
  };

  test('a to-one nulled while its key is set, read by a source', async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        relations: { org: { where: free } },
        sources: { name: rule({ field: 'org.plan', operator: 'notEquals', value: 'free' }) },
      },
    };
    const raw = await fetch(lens);
    const fetched = materializeSources(lens, raw)[0].options.map((o) => o.value);
    expect(fetched).not.toContain('nine');
    expect(
      materializeSources(lens, projectRows(lens, raw, { keepClampColumns: true }))[0].options.map(
        (o) => o.value,
      ),
    ).toEqual(fetched);
    const error = thrown(() => materializeSources(lens, projectRows(lens, raw)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.message).toMatch(/'org' is null while its key is set/);
  });

  test('a to-one nulled while its key is set, on the way down to a source', async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { relations: { org: { where: free, sources: { name: true } } } },
    };
    const raw = await fetch(lens);
    expect(materializeSources(lens, raw)[0].options.map((o) => o.value)).not.toContain('R');
    expect(thrown(() => materializeSources(lens, projectRows(lens, raw)))).toBeInstanceOf(
      UsageError,
    );
  });

  test('a relation missing on the path, or of the wrong shape, is the caller’s', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { relations: { posts: { sources: { title: true } } } },
    };
    const user = {
      id: 1,
      name: 'a',
      age: 1,
      score: 1,
      createdAt: null,
      meta: null,
      tags: [],
      role: null,
      orgId: null,
    };
    expect(thrown(() => materializeSources(lens, [user]))?.message).toMatch(/lacks 'posts'/);
    expect(
      thrown(() =>
        materializeSources(lens, [
          { ...user, posts: { id: 1, title: 't', authorId: 1, views: null } },
        ]),
      )?.message,
    ).toMatch(/one row where it names a list/);
    expect(materializeSources(lens, [{ ...user, posts: [] }])[0].options).toEqual([]);
  });
});

describe('R12-2: caller input is a UsageError', () => {
  test('a row path as the time zone', () => {
    expect(
      thrown(() =>
        check(rule({ field: 'd', dateOperator: 'dayIn', value: ['monday'] }), { d: '2026-10-05' }, {
          timeZone: { path: 'tz' },
        } as never),
      ),
    ).toBeInstanceOf(UsageError);
  });

  test('a lens together with a map', () => {
    expect(
      thrown(() => toPrisma(true, { lens: base, map, model: 'User' } as never)),
    ).toBeInstanceOf(UsageError);
  });

  test('a model source handed to materializeSources', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { sources: { name: { from: 'mapDefaults' } } },
      mapDefaults: { prisma: { models: { User: { sources: { name: true } } } } },
    };
    expect(thrown(() => materializeSources(lens, []))).toBeInstanceOf(UsageError);
  });
});
