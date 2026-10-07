import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Condition } from '../index';
import { check, toSql } from '../index';

// The SQL rail treats DateTime as timestamptz. A plain `timestamp` column (Prisma's default)
// holds UTC wall time and casts through the session zone, which Prisma keeps at UTC — so a
// shift across DST and a weekday in a far zone land on the same rows for both column types.

const rule = (r: object): Condition => r as never;
const NOW = new Date('2026-11-05T00:00:00Z');

const rows = [
  { id: 1, ts: '2026-11-01T02:30:00Z', anchor: '2026-11-02T03:00:00Z' },
  { id: 2, ts: '2026-11-01T05:30:00Z', anchor: '2026-11-02T03:00:00Z' },
  { id: 3, ts: '2026-11-02T10:30:00Z', anchor: '2026-11-02T03:00:00Z' },
  { id: 4, ts: '2026-11-02T09:00:00Z', anchor: '2026-11-02T03:00:00Z' },
  { id: 5, ts: '2026-11-01T11:00:00Z', anchor: '2026-11-02T03:00:00Z' },
];

const run = async (type: 'TIMESTAMP' | 'TIMESTAMPTZ', condition: Condition, timeZone: string) => {
  const db = new PGlite();
  await db.exec(`SET TIME ZONE 'UTC'; CREATE TABLE t (id INT, ts ${type}, anchor ${type})`);
  for (const r of rows) await db.query('INSERT INTO t VALUES ($1, $2, $3)', [r.id, r.ts, r.anchor]);
  const { sql, params } = toSql(condition, { now: NOW, timeZone });
  const ids = (
    await db.query<{ id: number }>(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)
  ).rows.map((r) => r.id);
  await db.close();
  return ids;
};

const inMemory = (condition: Condition, timeZone: string) =>
  rows.filter((r) => check(condition, r, { now: NOW, timeZone }) === true).map((r) => r.id);

describe.each(['TIMESTAMP', 'TIMESTAMPTZ'] as const)('a %s column', (type) => {
  test('a row-based shift across a DST change', async () => {
    const r = rule({
      field: 'ts',
      dateOperator: 'after',
      path: '$.anchor',
      offset: { value: { ago: { days: 1 } } },
    });
    expect(await run(type, r, 'America/New_York')).toEqual(inMemory(r, 'America/New_York'));
  });

  test('a weekday in a zone far from UTC', async () => {
    const r = rule({ field: 'ts', dateOperator: 'dayIn', value: ['monday'] });
    expect(await run(type, r, 'Pacific/Kiritimati')).toEqual(inMemory(r, 'Pacific/Kiritimati'));
  });
});
