import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { createDB } from 'mysql-memory-server';
import type { Condition, Lens, LensNarrowing } from '../index';
import { check, engineGlobals, Operator, SqlDialect, toLensWhereSql, toWhereSql } from '../index';
import {
  affiliations,
  asChecked,
  checkedIds,
  whereSqlColumns as columns,
  eq,
  fanUsers,
  forms,
  joinedQuery,
  whereSqlLensCases as lensCases,
  lensKeptIds,
  whereSqlMaps as maps,
  whereSqlRules as rules,
  whereSqlTables as tables,
  tricky,
  whereSqlJoinCases,
  whereSqlLensColumns,
  whereSqlLensTables,
} from './fixtures/whereSql';

// Differential: check() and the predicate toWhereSql writes, run by a real mysqld, return the
// same rows. The binary downloads once into os.tmpdir()/mysqlmsn/binaries, which CI caches (see
// .github/workflows/ci.yml); keep the version in step with the cache key.
const MYSQL_VERSION = '8.4.11';

const options = { columns, tables, map: { maps }, mapName: 'app', model: 'FanUser' };

const toBit = (b: boolean | null): string => (b === null ? 'NULL' : b ? '1' : '0');
const str = (s: string | null): string =>
  s === null ? 'NULL' : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const at = (d: Date | null): string =>
  d === null ? 'NULL' : `'${d.toISOString().slice(0, 19).replace('T', ' ')}'`;

let db: Awaited<ReturnType<typeof createDB>>;
let sql: SQL;

const ids = async (query: string): Promise<number[]> =>
  ((await sql.unsafe(query)) as { id: number }[]).map((r) => Number(r.id));

beforeAll(async () => {
  engineGlobals.set('sql.dialect', SqlDialect.mysql);
  db = await createDB({ version: MYSQL_VERSION, downloadBinaryOnce: true, logLevel: 'ERROR' });
  sql = new SQL({
    adapter: 'mysql',
    hostname: '127.0.0.1',
    port: db.port,
    username: db.username,
    database: db.dbName,
  });
  // A binary collation: check() compares strings exactly (see the collation case below).
  await sql.unsafe(
    'CREATE TABLE forms (id INT PRIMARY KEY, status VARCHAR(64) COLLATE utf8mb4_0900_bin NULL)',
  );
  await sql.unsafe(
    `CREATE TABLE fan_users (id INT PRIMARY KEY, affiliation VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
      score INT NULL, active BOOLEAN NULL, verified_at DATETIME NULL, form_id INT NULL)`,
  );
  await sql.unsafe(
    `CREATE TABLE fan_user_affiliations (id INT PRIMARY KEY, fan_user_id INT NULL,
      affiliation VARCHAR(64) COLLATE utf8mb4_0900_bin NULL, ended_at DATETIME NULL, deleted_at DATETIME NULL)`,
  );
  await sql.unsafe(
    `INSERT INTO forms VALUES ${forms.map((f) => `(${f.id}, ${str(f.status)})`).join(', ')}`,
  );
  await sql.unsafe(
    `INSERT INTO fan_user_affiliations VALUES ${affiliations
      .map(
        (a) =>
          `(${a.id}, ${a.fanUserId}, ${str(a.affiliation)}, ${at(a.endedAt)}, ${at(a.deletedAt)})`,
      )
      .join(', ')}`,
  );
  await sql.unsafe(
    `INSERT INTO fan_users VALUES ${fanUsers
      .map(
        (u) =>
          `(${u.id}, ${str(u.affiliation)}, ${u.score ?? 'NULL'}, ${toBit(u.active)}, ${at(u.verifiedAt)}, ${u.formId ?? 'NULL'})`,
      )
      .join(', ')}`,
  );
}, 600_000);

afterAll(async () => {
  engineGlobals.reset();
  await sql?.close();
  await db?.stop();
});

describe('toWhereSql (mysql) — check() and mysqld agree', () => {
  for (const [label, rule] of Object.entries(rules)) {
    it(label, async () => {
      const where = toWhereSql(rule, options);
      const viaSql = await ids(
        `SELECT u.id FROM fan_users u LEFT JOIN forms f ON f.id = u.form_id WHERE ${where} ORDER BY u.id`,
      );
      expect(viaSql).toEqual(checkedIds(rule));
    });
  }

  it('the quote-and-backslash value matches exactly its own row', async () => {
    const where = toWhereSql(eq('affiliation', tricky), options);
    expect(await ids(`SELECT u.id FROM fan_users u WHERE ${where}`)).toEqual([4]);
  });

  it("follows the column's collation: a _ci column folds case, which check() does not", async () => {
    // Documented, not a divergence the engine can close: it writes `=` against the caller's column.
    const where = toWhereSql(eq('affiliation', 'advocate'), {
      ...options,
      columns: { ...columns, affiliation: 'u.affiliation COLLATE utf8mb4_0900_ai_ci' },
    });
    expect(await ids(`SELECT u.id FROM fan_users u WHERE ${where} ORDER BY u.id`)).toEqual([1, 5]);
  });
});

describe('toWhereSql (mysql) — a value of another type is refused, not cast', () => {
  // MySQL casts it (`score = FALSE` is `score = 0`, a string = 0 is every non-numeric string) and
  // matches rows check() doesn't.
  const misfits: [string, Condition, string][] = [
    ['false on an Int', eq('score', false), 'u.score = FALSE'],
    ['1 on a Boolean', eq('active', 1), 'u.active = 1'],
    ['0 on a String', eq('affiliation', 0), 'u.affiliation = 0'],
  ];
  for (const [label, rule, cast] of misfits)
    it(label, async () => {
      expect(fanUsers.filter((u) => check(rule, asChecked(u)) === true)).toEqual([]);
      expect((await ids(`SELECT u.id FROM fan_users u WHERE ${cast}`)).length).toBeGreaterThan(0);
      expect(() => toWhereSql(rule, options)).toThrow('does not fit');
    });
});

describe('toLensWhereSql (mysql) — check() and mysqld agree', () => {
  const base: Lens = { maps, mapName: 'app', model: 'FanUser' };
  const rootWhere: Condition = {
    any: [
      { field: 'affiliation', operator: Operator.notIn, value: ['prospect', 'Advocate'] },
      { field: 'form', operator: Operator.notExists },
    ],
  };
  const formWhere: Condition = { field: 'status', operator: Operator.notEquals, value: 'open' };
  const narrowing: LensNarrowing = {
    parent: base,
    root: { where: rootWhere, relations: { form: {} } },
    mapDefaults: { app: { models: { Form: { where: formWhere } } } },
  };
  const lensColumns = { ...columns, 'Form.status': 'f.status' };

  it('the root where returns the rows check() keeps', async () => {
    const { root } = toLensWhereSql(narrowing, { columns: lensColumns });
    const viaSql = await ids(
      `SELECT u.id FROM fan_users u LEFT JOIN forms f ON f.id = u.form_id WHERE ${root} ORDER BY u.id`,
    );
    expect(viaSql).toEqual(checkedIds(rootWhere));
  });

  it('a model default, keyed by map and model, returns the rows check() keeps', async () => {
    const { relations, mapDefaults } = toLensWhereSql(narrowing, { columns: lensColumns });
    expect(relations).toEqual({});
    const where = mapDefaults.app.models.Form;
    const viaSql = await ids(`SELECT f.id FROM forms f WHERE ${where} ORDER BY f.id`);
    const inMemory = forms.filter((f) => check(formWhere, f) === true).map((f) => f.id);
    expect(viaSql).toEqual(inMemory);
  });
});

describe('toLensWhereSql (mysql) — a to-many relation read through its clamps', () => {
  const keptViaSql = (lens: LensNarrowing, read: 'root' | 'FanUser'): Promise<number[]> => {
    const sqlOf = toLensWhereSql(lens, {
      columns: whereSqlLensColumns,
      tables: whereSqlLensTables,
    });
    const where = read === 'root' ? sqlOf.root : sqlOf.mapDefaults.app.models.FanUser;
    return ids(`SELECT u.id FROM fan_users u WHERE ${where ?? 'TRUE'} ORDER BY u.id`);
  };
  for (const [label, { lens, read, darkerThan }] of Object.entries(lensCases)) {
    it(label, async () => {
      const viaSql = await keptViaSql(lens, read);
      expect(viaSql).toEqual(lensKeptIds(lens));
      if (darkerThan) {
        const above = await keptViaSql(darkerThan, read);
        expect(viaSql.filter((id) => !above.includes(id))).toEqual([]);
      }
    });
  }
});

describe("toLensWhereSql (mysql) — toMany: 'join' on the caller's LEFT JOIN", () => {
  for (const [label, { lens, kept }] of Object.entries(whereSqlJoinCases)) {
    it(label, async () => {
      const sqlOf = toLensWhereSql(lens, { columns: whereSqlLensColumns, toMany: 'join' });
      expect(lensKeptIds(lens)).toEqual(kept);
      expect(await ids(joinedQuery(sqlOf))).toEqual(kept);
    });
  }
});
