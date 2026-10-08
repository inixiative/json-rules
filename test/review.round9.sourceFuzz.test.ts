import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  executePrismaPlan,
  type LensNarrowing,
  materializeSourceQuery,
  materializeSources,
  projectRows,
  type SourceQuery,
  toLensSelect,
  toPrisma,
  toSourceQueries,
  validateNarrowing,
} from '../index';
import { map, openRails } from './rails/harness';

// Round 9: a lens's source options are one set on every rail — the Prisma and SQL option queries,
// and materializeSources over what the library itself fetches (toLensSelect → findMany, as
// fetched and as projectRows keeps it for a re-check) — over random lenses with grants on hidden
// to-one and list rows, NULL columns, roots that show few columns, nested sources, labels, axes
// and pointers.

const SEED = `
INSERT INTO orgs (id, name, plan, seats, "parentId") VALUES (13, 'Zed', 'pro', NULL, 10), (14, 'Q', NULL, 3, NULL), (15, 'R', 'free', 9, 14), (16, 'Acme', 'pro', 2, 15);
INSERT INTO users (id, name, age, score, tags, "orgId") VALUES (6, 'six', NULL, NULL, '{}', 13), (7, 'seven', 50, 9, '{}', 14), (8, NULL, NULL, NULL, '{}', NULL), (9, 'nine', 3, 1, '{}', 15), (20, 'Ann', 5, 2, '{}', 16), (21, 'bob', 30, NULL, '{}', 16);
INSERT INTO posts (id, "authorId", views, title) VALUES (104, 6, NULL, NULL), (105, 7, 3, 'x'), (106, 7, 20, NULL), (107, 2, NULL, 'b'), (108, 4, 1, NULL), (109, 9, 7, 'hello'), (110, 20, 10, 'x'), (111, 21, 3, 'hello');
`;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(SEED);
});
afterAll(async () => {
  await rails.close();
});

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });

let seed = 1;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];

const REL: Record<string, [string, string, boolean][]> = {
  User: [
    ['org', 'Org', false],
    ['posts', 'Post', true],
  ],
  Org: [
    ['parent', 'Org', false],
    ['children', 'Org', true],
    ['users', 'User', true],
  ],
  Post: [['author', 'User', false]],
};
const COLS: Record<string, [string, unknown[]][]> = {
  User: [
    ['age', [5, 30]],
    ['name', ['Ann', 'bob']],
    ['score', [1, 2]],
  ],
  Org: [
    ['seats', [0, 5]],
    ['plan', ['pro', 'free']],
    ['name', ['Acme', 'Zed']],
  ],
  Post: [
    ['views', [3, 10]],
    ['title', ['hello', 'x']],
  ],
};
const STR: Record<string, string[]> = { User: ['name'], Org: ['plan', 'name'], Post: ['title'] };
const TO_ONE: Record<string, string[]> = {
  User: ['org.name', 'org.plan', 'org.parent.name'],
  Org: ['parent.name', 'parent.plan'],
  Post: ['author.name', 'author.org.name'],
};

type Node = Record<string, unknown>;

const leaf = (model: string, depth = 1): Condition => {
  const [column, values] = pick(COLS[model]);
  const simple = pick([
    { field: column, operator: 'exists' },
    { field: column, operator: 'notEquals', value: pick(values) },
    {
      field: column,
      operator: typeof values[0] === 'number' ? 'greaterThanEquals' : 'equals',
      value: pick(values),
    },
  ]) as Condition;
  if (depth <= 0 || rnd() < 0.5) return simple;
  const [field, target, list] = pick(REL[model]);
  if (list)
    return {
      field,
      arrayOperator: pick(['any', 'all', 'none']),
      condition: leaf(target, depth - 1),
    } as Condition;
  if (rnd() < 0.3) return { field, operator: pick(['exists', 'notExists']) } as Condition;
  const inner = leaf(target, 0) as Node;
  return { ...inner, field: `${field}.${inner.field}` } as Condition;
};

const sourceFor = (model: string): unknown => {
  const k = rnd();
  if (k < 0.15) return true;
  if (k < 0.5) return leaf(model, 2);
  const where = rnd() < 0.6 ? { where: leaf(model, 2) } : {};
  if (k < 0.75) return { label: rnd() < 0.5 ? pick(STR[model]) : pick(TO_ONE[model]), ...where };
  return { groupBy: pick(TO_ONE[model]), ...where };
};

const node = (model: string, depth: number, onPath = false): Node => {
  const n: Node = {};
  if (rnd() < 0.4) n.where = leaf(model, 1);
  if (rnd() < 0.3)
    n.picks = pick([[], ['id'], [pick(COLS[model])[0]], ['id', pick(COLS[model])[0]]]);
  else if (rnd() < 0.15) n.omits = [pick(COLS[model])[0]];
  if (rnd() < 0.5)
    n.sources = {
      [pick(STR[model])]:
        onPath && rnd() < 0.3
          ? { from: 'mapDefaults', ...(rnd() < 0.5 ? { where: leaf(model, 2) } : {}) }
          : sourceFor(model),
    };
  if (depth > 0 && rnd() < 0.75) {
    const relations: Node = {};
    for (const [field, target] of REL[model])
      if (rnd() < 0.55) relations[field] = node(target, depth - 1, onPath);
    n.relations = relations;
  }
  return n;
};

const randLens = (): LensNarrowing => {
  const models: Node = {};
  for (const m of Object.keys(REL)) if (rnd() < 0.8) models[m] = node(m, 1);
  const l1: LensNarrowing = {
    parent: base,
    mapDefaults: { prisma: { models } } as never,
    ...(rnd() < 0.8 && { root: node('User', 3, true) as never }),
  };
  if (rnd() < 0.5) return l1;
  const m = pick(Object.keys(REL));
  const l2: Node = { parent: l1 };
  if (rnd() < 0.6)
    l2.mapDefaults = {
      prisma: {
        models: {
          [m]: {
            where: leaf(m, 1),
            ...(rnd() < 0.4 ? { sources: { [pick(STR[m])]: sourceFor(m) } } : {}),
          },
        },
      },
    };
  if (rnd() < 0.7) {
    const root = node('User', 2, true);
    delete root.picks;
    delete root.omits;
    l2.root = root;
  }
  return l2 as never;
};

const delegates = () =>
  rails.prisma as unknown as Record<string, { findMany: (args: object) => Promise<object[]> }>;

const onPrisma = async (query: SourceQuery) => {
  if (query.prisma === null) return null;
  const { model, steps, ...args } = query.prisma;
  const where = steps
    ? await executePrismaPlan({ steps } as never, rails.prisma as never)
    : args.where;
  const rows = await delegates()[model.charAt(0).toLowerCase() + model.slice(1)].findMany({
    ...args,
    where,
  });
  return materializeSourceQuery(query, rows as never).options;
};

const onSql = async (query: SourceQuery) =>
  query.sql.sql === null
    ? null
    : materializeSourceQuery(
        query,
        (await rails.db.query(query.sql.sql, query.sql.params)).rows as never,
        { rowShape: 'sql' },
      ).options;

let total = 0;

test.each(
  Array.from({ length: 24 }, (_, i) => i + 1),
)('seed %i: every rail offers one set of options', async (start) => {
  seed = start;
  const mismatches: string[] = [];
  let compared = 0;
  for (let i = 0; i < 150; i++) {
    const lens = randLens();
    if (!validateNarrowing(lens).ok) continue;
    const queries = toSourceQueries(lens);
    // The library's own fetch, as the documented pipeline runs it.
    const where = await executePrismaPlan(toPrisma(true, { lens }), rails.prisma as never);
    const fetched = (await rails.prisma.user.findMany({
      where: where as never,
      select: toLensSelect(lens).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];
    const kept = projectRows(lens, fetched, { keepGrantColumns: true });
    // A model source (a pointer) offers rows a fetched collection needn't hold:
    // materializeSources refuses it, and only the option queries serve it.
    const materialize = (rows: Record<string, unknown>[]) => {
      try {
        return materializeSources(lens, rows);
      } catch (error) {
        if (!/offers its model's own source/.test((error as Error).message)) throw error;
        return null;
      }
    };
    const fromFetched = materialize(fetched);
    const fromKept = materialize(kept);
    for (const query of queries) {
      const prisma = await onPrisma(query);
      const sql = await onSql(query);
      if (prisma === null) continue;
      compared++;
      const want = JSON.stringify(prisma);
      const tag = `#${i} ${query.path}.${query.field} ${JSON.stringify(query.composedWhere)}`;
      if (sql !== null && JSON.stringify(sql) !== want)
        mismatches.push(`sql ${tag}: ${JSON.stringify(sql)} vs ${want}`);
      if (!fromFetched || !fromKept) continue;
      const at = (all: typeof fromFetched) =>
        JSON.stringify(all.find((v) => v.path === query.path && v.field === query.field)?.options);
      if (at(fromFetched) !== want)
        mismatches.push(`fetched ${tag}: ${at(fromFetched)} vs ${want}`);
      if (at(fromKept) !== want) mismatches.push(`kept ${tag}: ${at(fromKept)} vs ${want}`);
    }
  }
  expect(mismatches).toEqual([]);
  total += compared;
}, 60_000);

test('the seeds compared enough option queries', () => {
  expect(total).toBeGreaterThan(400);
});
