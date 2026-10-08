import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  describeRule,
  type LensNarrowing,
  toPrisma,
  toSql,
  validateRule,
} from '../index';
import { map, NOW, openRails } from './rails/harness';

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const lens: LensNarrowing = {
  parent: base,
  root: { relations: { posts: {}, org: { relations: { parent: {}, users: {} } } } },
};
let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(
    `INSERT INTO users (id, tags) VALUES (6, '{}'); INSERT INTO posts (id, "authorId", views, title) VALUES (104, 6, NULL, NULL), (105, 4, 4, 'x');`,
  );
});
afterAll(async () => {
  await rails.close();
});
const ops = [
  'equals',
  'notEquals',
  'lessThan',
  'lessThanEquals',
  'greaterThan',
  'greaterThanEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'notStartsWith',
  'notEndsWith',
  'in',
  'notIn',
  'matches',
  'notMatches',
];
const leaves: [string, string][] = [
  ['age', 'orgId'],
  ['age', 'id'],
  ['name', 'name'],
  ['age', 'score'],
  ['createdAt', 'createdAt'],
  ['name', 'role'],
  ['age', '$.orgId'],
  ['age', 'org.id'],
  ['role', 'role'],
  ['name', 'tags'],
  ['tags', 'tags'],
  ['tags', 'name'],
];
const wraps: [string, (l: object) => object][] = [
  ['bare', (l) => l],
  ['ifneg', (l) => ({ if: l, then: false, else: true })],
  ['ifneg-nested', (l) => ({ if: { if: l, then: false, else: true }, then: false, else: true })],
  ['all-or', (l) => ({ any: [l, { field: 'id', operator: 'equals', value: 99 }] })],
  [
    'if-then',
    (l) => ({
      if: l,
      then: { field: 'id', operator: 'lessThan', value: 4 },
      else: { field: 'id', operator: 'greaterThan', value: 3 },
    }),
  ],
];
const postLeaves: [string, string][] = [
  ['views', '$.authorId'],
  ['views', '$.id'],
  ['id', '$.views'],
  ['views', 'age'],
  ['title', '$.title'],
  ['views', '$$.age'],
];
const arrayWraps: [string, (l: object) => object][] = [
  ['any', (l) => ({ field: 'posts', arrayOperator: 'any', condition: l })],
  ['all', (l) => ({ field: 'posts', arrayOperator: 'all', condition: l })],
  ['none', (l) => ({ field: 'posts', arrayOperator: 'none', condition: l })],
  ['atLeast', (l) => ({ field: 'posts', arrayOperator: 'atLeast', count: 1, condition: l })],
  [
    'any-ifneg',
    (l) => ({
      field: 'posts',
      arrayOperator: 'any',
      condition: { if: l, then: false, else: true },
    }),
  ],
  [
    'all-ifneg',
    (l) => ({
      field: 'posts',
      arrayOperator: 'all',
      condition: { if: l, then: false, else: true },
    }),
  ],
  [
    'agg',
    (l) => ({
      field: 'posts',
      aggregate: { mode: 'count' },
      operator: 'greaterThan',
      value: 0,
      condition: l,
    }),
  ],
  [
    'org.users-any',
    (l) => ({
      field: 'org.users',
      arrayOperator: 'any',
      condition: { field: 'posts', arrayOperator: 'any', condition: l },
    }),
  ],
];
const thrown = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return (e as Error).message.slice(0, 120);
  }
};
test('column-compare fuzz: supportedTargets matches what compiles, and the rails agree', async () => {
  const cases: [string, Condition][] = [];
  for (const op of ops) {
    for (const [f, p] of leaves)
      for (const [w, wf] of wraps)
        cases.push([`${w}:${f} ${op} ${p}`, wf({ field: f, operator: op, path: p }) as Condition]);
    for (const [f, p] of postLeaves)
      for (const [w, wf] of arrayWraps)
        cases.push([`${w}:${f} ${op} ${p}`, wf({ field: f, operator: op, path: p }) as Condition]);
  }
  let n = 0,
    bad = 0;
  for (const [name, r] of cases) {
    n++;
    const d = describeRule(r, lens);
    const vP = validateRule(r, { target: 'toPrisma', map, model: 'User' }).ok;
    const vS = validateRule(r, { target: 'toSql', map, model: 'User' }).ok;
    const cP = thrown(() => toPrisma(r, { map, model: 'User', now: NOW }));
    const cS = thrown(() => toSql(r, { map, model: 'User', now: NOW }));
    const claimP = d.supportedTargets.includes('toPrisma'),
      claimS = d.supportedTargets.includes('toSql');
    const issues: string[] = [];
    if (claimP !== (cP === null)) issues.push(`describe toPrisma=${claimP} compile=${cP ?? 'ok'}`);
    if (vP !== (cP === null)) issues.push(`validate toPrisma=${vP} compile=${cP ?? 'ok'}`);
    if (claimS !== (cS === null)) issues.push(`describe toSql=${claimS} compile=${cS ?? 'ok'}`);
    if (vS !== (cS === null)) issues.push(`validate toSql=${vS} compile=${cS ?? 'ok'}`);
    const ran = await rails.run(r);
    const c = JSON.stringify(ran.check);
    if (cP === null && JSON.stringify(ran.prisma) !== c)
      issues.push(`prisma ${JSON.stringify(ran.prisma)} vs check ${c}`);
    if (cS === null && JSON.stringify(ran.sql) !== c)
      issues.push(`sql ${JSON.stringify(ran.sql)} vs check ${c}`);
    if (issues.length) {
      bad++;
      console.log('X', name, '|', issues.join(' || '));
    }
  }
  console.log('cases', n, 'bad', bad);
  expect(bad).toBe(0);
}, 120000);
