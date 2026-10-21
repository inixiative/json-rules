import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { createDB } from 'mysql-memory-server';
import type { Condition, FieldMapSet, Lens, LensNarrowing } from '../index';
import { check, Operator, toLensWhereSql, toWhereSql } from '../index';

// Differential: check() and the predicate toWhereSql writes, run by a real mysqld, return the
// same rows — NULL rows included. The binary downloads once into os.tmpdir()/mysqlmsn/binaries,
// which CI caches (see .github/workflows/ci.yml); keep the version in step with the cache key.
const MYSQL_VERSION = '8.4.11';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      FanUser: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          affiliation: { kind: 'scalar', type: 'String' },
          score: { kind: 'scalar', type: 'Int' },
          active: { kind: 'scalar', type: 'Boolean' },
          formId: { kind: 'scalar', type: 'Int' },
          form: {
            kind: 'object',
            type: 'Form',
            relationName: 'FanUserForm',
            fromFields: ['formId'],
            toFields: ['id'],
          },
        },
      },
      Form: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          status: { kind: 'scalar', type: 'String' },
        },
      },
    },
  },
};

const tricky = "O'Brien \\ x\\' %_";

type Form = { id: number; status: string | null };
const forms: Form[] = [
  { id: 1, status: 'open' },
  { id: 2, status: null },
  { id: 3, status: tricky },
];
type FanUser = {
  id: number;
  affiliation: string | null;
  score: number | null;
  active: boolean | null;
  formId: number | null;
};
const fanUsers: FanUser[] = [
  { id: 1, affiliation: 'advocate', score: 10, active: true, formId: 1 },
  { id: 2, affiliation: 'prospect', score: 5, active: false, formId: 2 },
  { id: 3, affiliation: null, score: null, active: null, formId: null },
  { id: 4, affiliation: tricky, score: 0, active: true, formId: 3 },
  { id: 5, affiliation: 'Advocate', score: 7, active: null, formId: 99 },
  { id: 6, affiliation: 'advocate ', score: -1, active: false, formId: 1 },
];
// Each row as check() reads it: the to-one relation nested, null when there is no row.
const asChecked = (u: FanUser) => ({
  ...u,
  form: forms.find((f) => f.id === u.formId) ?? null,
});

const columns = {
  id: 'u.id',
  affiliation: 'u.affiliation',
  score: 'u.score',
  active: 'u.active',
  formId: 'u.form_id',
  'form.id': 'f.id',
  'form.status': 'f.status',
};

const eq = (field: string, value: unknown): Condition =>
  ({ field, operator: Operator.equals, value }) as Condition;

const rules: Record<string, Condition> = {
  'equals advocate': eq('affiliation', 'advocate'),
  'equals null': eq('affiliation', null),
  'equals number': eq('score', 5),
  'equals true': eq('active', true),
  'equals false': eq('active', false),
  'equals quote and backslash': eq('affiliation', tricky),
  'notEquals advocate': { field: 'affiliation', operator: Operator.notEquals, value: 'advocate' },
  'notEquals null': { field: 'affiliation', operator: Operator.notEquals, value: null },
  'notEquals number': { field: 'score', operator: Operator.notEquals, value: 5 },
  'notEquals true': { field: 'active', operator: Operator.notEquals, value: true },
  'notEquals quote and backslash': {
    field: 'affiliation',
    operator: Operator.notEquals,
    value: tricky,
  },
  'in strings': { field: 'affiliation', operator: Operator.in, value: ['advocate', 'prospect'] },
  'in with null': { field: 'affiliation', operator: Operator.in, value: ['prospect', null] },
  'in only null': { field: 'affiliation', operator: Operator.in, value: [null] },
  'in empty': { field: 'affiliation', operator: Operator.in, value: [] },
  'in numbers': { field: 'score', operator: Operator.in, value: [0, 10, -1] },
  'in quote and backslash': { field: 'affiliation', operator: Operator.in, value: [tricky] },
  'notIn strings': {
    field: 'affiliation',
    operator: Operator.notIn,
    value: ['advocate', 'prospect'],
  },
  'notIn with null': { field: 'affiliation', operator: Operator.notIn, value: ['prospect', null] },
  'notIn only null': { field: 'affiliation', operator: Operator.notIn, value: [null] },
  'notIn empty': { field: 'affiliation', operator: Operator.notIn, value: [] },
  'notIn numbers': { field: 'score', operator: Operator.notIn, value: [0, 10] },
  'in null operand': { field: 'affiliation', operator: Operator.in, value: null },
  'notIn null operand': { field: 'affiliation', operator: Operator.notIn, value: null },
  exists: { field: 'affiliation', operator: Operator.exists },
  notExists: { field: 'active', operator: Operator.notExists },
  'relation exists': { field: 'form', operator: Operator.exists },
  'relation notExists': { field: 'form', operator: Operator.notExists },
  'through a relation': { field: 'form.status', operator: Operator.equals, value: 'open' },
  'negated through a relation': {
    field: 'form.status',
    operator: Operator.notIn,
    value: ['open'],
  },
  all: {
    all: [
      { field: 'form', operator: Operator.exists },
      { field: 'affiliation', operator: Operator.notEquals, value: 'prospect' },
    ],
  },
  any: {
    any: [
      eq('active', true),
      { field: 'score', operator: Operator.in, value: [5] },
      { all: [{ field: 'form', operator: Operator.notExists }, true] },
    ],
  },
  'all empty': { all: [] },
  'any empty': { any: [] },
  false: false,
};

const toBit = (b: boolean | null): string => (b === null ? 'NULL' : b ? '1' : '0');
const str = (s: string | null): string =>
  s === null ? 'NULL' : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

let db: Awaited<ReturnType<typeof createDB>>;
let sql: SQL;

const ids = async (query: string): Promise<number[]> =>
  ((await sql.unsafe(query)) as { id: number }[]).map((r) => Number(r.id));

beforeAll(async () => {
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
      score INT NULL, active BOOLEAN NULL, form_id INT NULL)`,
  );
  await sql.unsafe(
    `INSERT INTO forms VALUES ${forms.map((f) => `(${f.id}, ${str(f.status)})`).join(', ')}`,
  );
  await sql.unsafe(
    `INSERT INTO fan_users VALUES ${fanUsers
      .map(
        (u) =>
          `(${u.id}, ${str(u.affiliation)}, ${u.score ?? 'NULL'}, ${toBit(u.active)}, ${u.formId ?? 'NULL'})`,
      )
      .join(', ')}`,
  );
}, 600_000);

afterAll(async () => {
  await sql?.close();
  await db?.stop();
});

describe('toWhereSql (mysql) — check() and mysqld agree', () => {
  for (const [label, rule] of Object.entries(rules)) {
    it(label, async () => {
      const where = toWhereSql(rule, {
        columns,
        dialect: 'mysql',
        map: { maps },
        mapName: 'app',
        model: 'FanUser',
      });
      const viaSql = await ids(
        `SELECT u.id FROM fan_users u LEFT JOIN forms f ON f.id = u.form_id WHERE ${where} ORDER BY u.id`,
      );
      const inMemory = fanUsers.filter((u) => check(rule, asChecked(u)) === true).map((u) => u.id);
      expect(viaSql).toEqual(inMemory);
    });
  }

  it('the quote-and-backslash value matches exactly its own row', async () => {
    const where = toWhereSql(eq('affiliation', tricky), { columns, dialect: 'mysql' });
    expect(await ids(`SELECT u.id FROM fan_users u WHERE ${where}`)).toEqual([4]);
  });

  it("follows the column's collation: a _ci column folds case, which check() does not", async () => {
    // Documented, not a divergence the engine can close: it writes `=` against the caller's column.
    const where = toWhereSql(eq('affiliation', 'advocate'), {
      columns: { affiliation: 'u.affiliation COLLATE utf8mb4_0900_ai_ci' },
      dialect: 'mysql',
    });
    expect(await ids(`SELECT u.id FROM fan_users u WHERE ${where} ORDER BY u.id`)).toEqual([1, 5]);
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

  it('the root where returns the rows check() keeps', async () => {
    const { root } = toLensWhereSql(narrowing, { columns, dialect: 'mysql' });
    const viaSql = await ids(
      `SELECT u.id FROM fan_users u LEFT JOIN forms f ON f.id = u.form_id WHERE ${root} ORDER BY u.id`,
    );
    const inMemory = fanUsers
      .filter((u) => check(rootWhere, asChecked(u)) === true)
      .map((u) => u.id);
    expect(viaSql).toEqual(inMemory);
  });

  it('the mapDefaults where, keyed by the relation, returns the rows check() keeps', async () => {
    const { relations } = toLensWhereSql(narrowing, { columns, dialect: 'mysql' });
    expect(Object.keys(relations)).toEqual(['form']);
    const viaSql = await ids(`SELECT f.id FROM forms f WHERE ${relations.form} ORDER BY f.id`);
    const inMemory = forms.filter((f) => check(formWhere, f) === true).map((f) => f.id);
    expect(viaSql).toEqual(inMemory);
  });
});
