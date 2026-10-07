import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition, FieldMap } from '../index';
import { check, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// An `if` whose field is NULL is false, so the implication holds — on every rail. SQL's
// NOT(NULL) and Prisma's NOT both dropped the row.

const rows = [
  { id: 1, age: 30, name: 'Ann' },
  { id: 2, age: null, name: 'Bob' },
  { id: 3, age: 30, name: 'Zed' },
  { id: 4, age: 40, name: 'Cy' },
];
const implication: Condition = {
  if: { field: 'age', operator: 'equals', value: 30 },
  then: { field: 'name', operator: 'equals', value: 'Zed' },
};
const withElse: Condition = {
  ...implication,
  else: { field: 'name', operator: 'equals', value: 'Cy' },
};

describe('an implication with a NULL antecedent', () => {
  test('check() and executed SQL agree', async () => {
    const db = new PGlite();
    await db.exec('CREATE TABLE t (id INT, age INT, name TEXT)');
    for (const r of rows)
      await db.query('INSERT INTO t VALUES ($1, $2, $3)', [r.id, r.age, r.name]);
    for (const rule of [implication, withElse]) {
      const inMemory = rows.filter((r) => check(rule, r) === true).map((r) => r.id);
      const { sql, params } = toSql(rule);
      const viaSql = (
        await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
      ).rows.map((r) => r.id);
      expect(viaSql).toEqual(inMemory);
    }
    expect(rows.filter((r) => check(implication, r) === true).map((r) => r.id)).toEqual([2, 3, 4]);
    await db.close();
  });

  test('toPrisma keeps the NULL row the map licenses', () => {
    const map: FieldMap = {
      models: {
        P: {
          fields: {
            id: { kind: 'scalar', type: 'Int' },
            age: { kind: 'scalar', type: 'Int', isRequired: false },
            name: { kind: 'scalar', type: 'String' },
          },
        },
      },
    };
    expect(
      getWhere(
        toPrisma(implication, {
          map: { maps: { app: map } } as never,
          mapName: 'app',
          model: 'P',
        } as never),
      ),
    ).toEqual({
      OR: [{ OR: [{ age: { not: 30 } }, { age: { equals: null } }] }, { name: { equals: 'Zed' } }],
    });
  });
});
