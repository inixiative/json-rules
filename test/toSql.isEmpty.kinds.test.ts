import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';

// The toSql twin of test/toPrisma.isEmpty.kinds.test.ts (2.18.3, ZLT-3899): the
// ''-branch belongs to String (and Json) columns only. Postgres rejects '' on a
// timestamp or integer at parse time, so the two-branch shape on a typed non-String
// column is guaranteed-unrunnable SQL — including the documented `deletedAt isEmpty`
// soft-delete lens grant.
const map: FieldMap = {
  models: {
    Enrichment: {
      fields: {
        value: { kind: 'scalar', type: 'String' },
        sourceUpdatedAt: { kind: 'scalar', type: 'DateTime' },
        score: { kind: 'scalar', type: 'Int' },
        metadata: { kind: 'scalar', type: 'Json' },
        status: { kind: 'enum', type: 'Status', values: ['active', 'paused'] },
      },
    },
  },
  enums: { Status: ['active', 'paused'] },
};
const opts = { map, model: 'Enrichment' };

describe('toSql isEmpty/notEmpty — the ""-branch is String-only', () => {
  it('String keeps the null-or-empty-string OR', () => {
    const { sql } = toSql({ field: 'value', operator: Operator.isEmpty }, opts);
    expect(sql).toBe(`("t0"."value" IS NULL OR "t0"."value" = '')`);
  });

  it('DateTime compiles to a pure null check', () => {
    const { sql } = toSql({ field: 'sourceUpdatedAt', operator: Operator.isEmpty }, opts);
    expect(sql).toBe(`"t0"."sourceUpdatedAt" IS NULL`);
  });

  it('DateTime notEmpty compiles to a pure not-null check', () => {
    const { sql } = toSql({ field: 'sourceUpdatedAt', operator: Operator.notEmpty }, opts);
    expect(sql).toBe(`"t0"."sourceUpdatedAt" IS NOT NULL`);
  });

  it('Int and enum columns drop the ""-branch too', () => {
    expect(toSql({ field: 'score', operator: Operator.isEmpty }, opts).sql).toBe(
      `"t0"."score" IS NULL`,
    );
    expect(toSql({ field: 'status', operator: Operator.notEmpty }, opts).sql).toBe(
      `"t0"."status" IS NOT NULL`,
    );
  });

  it('a stamped coerceType is the fallback authority without a map', () => {
    expect(
      toSql({ field: 'deletedAt', operator: Operator.isEmpty, coerceType: 'DateTime' }).sql,
    ).toBe(`"deletedAt" IS NULL`);
  });

  it('no type information keeps the legacy two-branch shape', () => {
    expect(toSql({ field: 'anything', operator: Operator.isEmpty }).sql).toBe(
      `("anything" IS NULL OR "anything" = '')`,
    );
  });
});

describe('the emitted SQL runs against real non-String columns', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      `CREATE TABLE "Enrichment" (id INT, "value" TEXT, "sourceUpdatedAt" TIMESTAMP, score INT)`,
    );
    await db.exec(
      `INSERT INTO "Enrichment" VALUES (1, 'a', NOW(), 5), (2, '', NULL, NULL), (3, NULL, NOW(), 0)`,
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('deletedAt-style isEmpty executes instead of raising invalid input syntax', async () => {
    const { sql, params } = toSql({ field: 'sourceUpdatedAt', operator: Operator.isEmpty }, opts);
    const rows = await db.query<{ id: number }>(
      `SELECT id FROM "Enrichment" t0 WHERE ${sql}`,
      params,
    );
    expect(rows.rows.map((r) => r.id)).toEqual([2]);
  });

  it('Int notEmpty executes and keeps the zero row', async () => {
    const { sql, params } = toSql({ field: 'score', operator: Operator.notEmpty }, opts);
    const rows = await db.query<{ id: number }>(
      `SELECT id FROM "Enrichment" t0 WHERE ${sql}`,
      params,
    );
    expect(rows.rows.map((r) => r.id)).toEqual([1, 3]);
  });
});
