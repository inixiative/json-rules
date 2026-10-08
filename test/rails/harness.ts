import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { buildPrismaMapV7 } from '@inixiative/prisma-map';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Condition, FieldMap, Lens, LensNarrowing } from '../../index';
import { check, executePrismaPlan, narrowRule, toPrisma, toSql } from '../../index';
import { PrismaClient } from './generated/client';

// The three rails on one database: check() over the rows Prisma loads, toSql executed by
// Postgres (PGlite), and toPrisma executed by Prisma 7 through PGlite's socket server — the
// pipeline a consumer runs, from a FieldMap that prisma-map reads off the generated client.

const GENERATED = join(import.meta.dir, 'generated');

export const map: FieldMap = { models: buildPrismaMapV7(GENERATED) as FieldMap['models'] };

export const NOW = new Date('2026-10-06T12:00:00Z');

const SEED = `
INSERT INTO orgs (id, name, plan, seats, "foundedAt", settings, "parentId") VALUES
  (10, 'Acme', 'pro', 5, '2020-01-01', '{"tier":"gold","limit":7,"nums":[1,2]}', NULL),
  (11, 'acme', NULL, NULL, NULL, NULL, 10),
  (12, NULL, 'free', 0, '2026-10-05', '{"tier":null,"nums":[]}', 11);
INSERT INTO users (id, name, age, score, "createdAt", meta, tags, "orgId") VALUES
  (1, 'Ann', 30, 1.5, '2026-10-05 10:00', '{"a":{"b":"x"},"n":3,"list":[1,2,3]}', '{a,b}', 10),
  (2, 'bob', NULL, NULL, NULL, NULL, '{}', 11),
  (3, NULL, 5, 2, '2026-10-04 23:30', '{"a":null,"n":null,"list":[]}', '{}', 12),
  (4, 'Dee', 40, 0, '2025-01-01', '{"a":{"b":"X"}}', '{c}', NULL),
  (5, 'nullable', 7, NULL, NULL, 'null', '{}', NULL);
INSERT INTO posts (id, "authorId", views, title) VALUES
  (100, 1, 10, 'hello'),
  (101, 1, 5, NULL),
  (102, 3, NULL, 'Hi'),
  (103, 1, NULL, 'later');
UPDATE users SET role = 'admin' WHERE id = 1;
UPDATE users SET role = 'Guest' WHERE id = 3;
UPDATE users SET role = 'member' WHERE id = 4;
`;

/** Each rail's matching user ids, or the message it threw. */
export type RailResult = number[] | `throws: ${string}`;
export type Rails = { check: RailResult; sql: RailResult; prisma: RailResult };
/** `lens`: compile with `{ lens }` on the compiled rails, and check `narrowRule(rule, lens)`. */
export type RailOptions = {
  context?: Record<string, unknown>;
  timeZone?: string;
  now?: Date;
  lens?: Lens | LensNarrowing;
};

const attempt = async (run: () => Promise<number[]> | number[]): Promise<RailResult> => {
  try {
    return await run();
  } catch (error) {
    return `throws: ${(error as Error).message.split('\n').filter(Boolean).at(-1)}`;
  }
};

/** `seed` adds rows after the base fixture's. */
export const openRails = async (seed = '') => {
  const db = new PGlite();
  await db.exec(readFileSync(join(GENERATED, 'schema.sql'), 'utf8'));
  await db.exec(SEED + seed);
  const dir = mkdtempSync(join(tmpdir(), 'json-rules-rails-'));
  const server = new PGLiteSocketServer({ db, path: join(dir, '.s.PGSQL.5432') });
  await server.start();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: `postgresql://postgres@localhost/postgres?host=${dir}`,
      max: 1,
    }),
  });
  // check() reads the rows a consumer holds: what Prisma loads, relations included.
  const rows = await prisma.user.findMany({
    include: {
      org: {
        include: { users: { include: { org: true } }, parent: { include: { parent: true } } },
      },
      posts: { include: { author: true } },
    },
    orderBy: { id: 'asc' },
  });
  const table = map.models.User?.dbName ?? 'User';

  const run = async (rule: Condition, options: RailOptions = {}): Promise<Rails> => {
    const { lens, ...opts } = { now: NOW, ...options };
    const schema = lens ? { lens } : { map, model: 'User' };
    const checked = lens ? narrowRule(rule, lens) : rule;
    return {
      check: await attempt(() =>
        rows.filter((row) => check(checked, row, opts as never) === true).map((row) => row.id),
      ),
      sql: await attempt(async () => {
        const { sql, params, joins } = toSql(rule, { ...opts, ...schema } as never);
        const query = `SELECT DISTINCT t0.id FROM "${table}" t0 ${joins.join(' ')} WHERE ${sql} ORDER BY t0.id`;
        return (await db.query<{ id: number }>(query, params)).rows.map((row) => row.id);
      }),
      prisma: await attempt(async () => {
        const plan = toPrisma(rule, { ...opts, ...schema } as never);
        const where = await executePrismaPlan(plan, prisma as never);
        const found = await prisma.user.findMany({
          where: where as never,
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        return found.map((row) => row.id);
      }),
    };
  };

  const close = async () => {
    await prisma.$disconnect();
    await server.stop();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { run, close, rows, prisma };
};

/** All three rails returning `ids`. */
export const agree = (ids: number[]): Rails => ({ check: ids, sql: ids, prisma: ids });
