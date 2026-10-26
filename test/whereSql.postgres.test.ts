import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { engineGlobals, SqlDialect, toLensWhereSql, toWhereSql } from '../index';
import {
  affiliations,
  checkedIds,
  whereSqlColumns as columns,
  eq,
  fanUsers,
  forms,
  whereSqlLensCases as lensCases,
  lensKeptIds,
  whereSqlMaps as maps,
  whereSqlRules as rules,
  whereSqlTables as tables,
  tricky,
  whereSqlLensColumns,
  whereSqlLensTables,
} from './fixtures/whereSql';

// Differential for the default dialect: check() and the predicate toWhereSql writes, run by
// PGlite, return the same rows. Postgres reads a string literal as written (no backslash
// escapes), so only the quote is doubled.

const options = { columns, tables, map: { maps }, mapName: 'app', model: 'FanUser' };

const str = (s: string | null): string => (s === null ? 'NULL' : `'${s.replace(/'/g, "''")}'`);
const bool = (b: boolean | null): string => (b === null ? 'NULL' : b ? 'TRUE' : 'FALSE');
const at = (d: Date | null): string => (d === null ? 'NULL' : `'${d.toISOString()}'`);

let db: PGlite;

const ids = async (query: string): Promise<number[]> =>
  (await db.query<{ id: number }>(query)).rows.map((r) => Number(r.id));

beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE forms (id INT PRIMARY KEY, status TEXT NULL)');
  await db.exec(
    `CREATE TABLE fan_users (id INT PRIMARY KEY, affiliation TEXT NULL, score INT NULL,
      active BOOLEAN NULL, verified_at TIMESTAMP NULL, form_id INT NULL)`,
  );
  await db.exec(
    `CREATE TABLE fan_user_affiliations (id INT PRIMARY KEY, fan_user_id INT NULL,
      affiliation TEXT NULL, ended_at TIMESTAMP NULL, deleted_at TIMESTAMP NULL)`,
  );
  await db.exec(
    `INSERT INTO forms VALUES ${forms.map((f) => `(${f.id}, ${str(f.status)})`).join(', ')}`,
  );
  await db.exec(
    `INSERT INTO fan_user_affiliations VALUES ${affiliations
      .map(
        (a) =>
          `(${a.id}, ${a.fanUserId}, ${str(a.affiliation)}, ${at(a.endedAt)}, ${at(a.deletedAt)})`,
      )
      .join(', ')}`,
  );
  await db.exec(
    `INSERT INTO fan_users VALUES ${fanUsers
      .map(
        (u) =>
          `(${u.id}, ${str(u.affiliation)}, ${u.score ?? 'NULL'}, ${bool(u.active)}, ${at(u.verifiedAt)}, ${u.formId ?? 'NULL'})`,
      )
      .join(', ')}`,
  );
});

afterAll(async () => {
  await db.close();
});

describe('toWhereSql (postgres, the default) — check() and PGlite agree', () => {
  it('runs under the default dialect', () => {
    expect(engineGlobals.get('sql.dialect')).toBe(SqlDialect.postgres);
  });

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
});

describe('toLensWhereSql (postgres) — a to-many relation read through its clamps', () => {
  for (const [label, { lens, read }] of Object.entries(lensCases)) {
    it(label, async () => {
      const sqlOf = toLensWhereSql(lens, {
        columns: whereSqlLensColumns,
        tables: whereSqlLensTables,
      });
      const where = read === 'root' ? sqlOf.root : sqlOf.mapDefaults.app.models.FanUser;
      const viaSql = await ids(`SELECT u.id FROM fan_users u WHERE ${where} ORDER BY u.id`);
      expect(viaSql).toEqual(lensKeptIds(lens));
    });
  }
});
