import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, toSql } from '../index';

// dayIn/dayNotIn compiled to a bare EXTRACT(DOW FROM col): the weekday was decided by
// the DB session's TimeZone GUC, not the evaluation's timezone policy, and diverged
// from checkDate's fieldDate.tz(tz). The emission now anchors the column as a UTC
// instant (the Prisma convention: DateTime columns store UTC wall time) and converts
// to the resolved zone, ending NAIVE — so extraction never consults the session zone.

// 2024-06-17T02:00:00 UTC is Monday 02:00 UTC = Sunday 22:00 America/New_York.
const ROWS = [
  { id: 1, ts: new Date('2024-06-17T02:00:00Z') },
  { id: 2, ts: new Date('2024-06-17T12:00:00Z') },
  { id: 3, ts: null },
];

describe('toSql dayIn/dayNotIn honor the timezone policy', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE t (id INT, ts TIMESTAMP)`);
    await db.exec(
      `INSERT INTO t VALUES (1,'2024-06-17T02:00:00'), (2,'2024-06-17T12:00:00'), (3,NULL)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const differential = async (rule: Condition, opts: Record<string, unknown>) => {
    const inMemory = ROWS.filter((r) => check(rule, r, opts) === true).map((r) => r.id);
    const { sql, params } = toSql(rule, opts);
    const viaSql = (
      await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql}`, params)
    ).rows.map((r) => r.id);
    expect(viaSql).toEqual(inMemory);
    return inMemory;
  };

  it('the emission anchors through UTC and ends naive in the resolved zone', () => {
    const { sql, params } = toSql(
      { field: 'ts', dateOperator: 'dayIn', value: ['sunday'] } as never,
      { timeZone: 'America/New_York' },
    );
    expect(sql).toBe(`EXTRACT(DOW FROM ("ts" AT TIME ZONE 'UTC' AT TIME ZONE $1)) = ANY($2)`);
    expect(params).toEqual(['America/New_York', [0]]);
  });

  it('dayIn under a non-UTC zone matches check()', async () => {
    const matched = await differential(
      { field: 'ts', dateOperator: 'dayIn', value: ['sunday'] } as never,
      { timeZone: 'America/New_York' },
    );
    expect(matched).toEqual([1]);
  });

  it('dayNotIn under a non-UTC zone matches check() (null still matches, 2.19.2)', async () => {
    const matched = await differential(
      { field: 'ts', dateOperator: 'dayNotIn', value: ['monday'] } as never,
      { timeZone: 'America/New_York' },
    );
    expect(matched).toEqual([1, 3]);
  });

  it('the default zone is UTC, session-independent', async () => {
    const matched = await differential(
      { field: 'ts', dateOperator: 'dayIn', value: ['monday'] } as never,
      {},
    );
    expect(matched).toEqual([1, 2]);
  });
});
