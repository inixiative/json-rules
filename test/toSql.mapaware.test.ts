import { describe, it, expect } from 'bun:test';
import { toSql, Operator, DateOperator } from '../index';
import { blogMap } from './fixtures/blogMap';
import { multiRelMap } from './fixtures/multiRelMap';
import { compositeFkMap } from './fixtures/compositeFkMap';

// ─── Result shape ─────────────────────────────────────────────────────────────
describe('toSql result shape', () => {
  it('always returns joins array even without map', () => {
    const result = toSql({ field: 'status', operator: Operator.equals, value: 'active' });
    expect(Array.isArray(result.joins)).toBe(true);
    expect(result.joins).toHaveLength(0);
  });

  it('joins empty when no relations traversed', () => {
    const result = toSql(
      { field: 'email', operator: Operator.equals, value: 'a@b.com' },
      { map: blogMap, model: 'User', alias: 't0' },
    );
    expect(result.joins).toHaveLength(0);
  });
});

// ─── path ref: $.field (column-to-column) ────────────────────────────────────
describe('toSql path ref: $.field', () => {
  it('$.field → column-to-column comparison (no param)', () => {
    const { sql, params } = toSql({
      field: 'endDate',
      operator: Operator.greaterThan,
      path: '$.startDate',
    });
    expect(sql).toBe('"endDate" > "startDate"');
    expect(params).toEqual([]);
  });

  it('$.field with equals → column = column', () => {
    const { sql, params } = toSql({
      field: 'confirmedAt',
      operator: Operator.equals,
      path: '$.createdAt',
    });
    expect(sql).toBe('"confirmedAt" = "createdAt"');
    expect(params).toEqual([]);
  });

  it('$.field with lessThan', () => {
    const { sql, params } = toSql({
      field: 'startDate',
      operator: Operator.lessThan,
      path: '$.endDate',
    });
    expect(sql).toBe('"startDate" < "endDate"');
    expect(params).toEqual([]);
  });

  it('date rule: $.field → column-to-column', () => {
    const { sql, params } = toSql({
      field: 'endDate',
      dateOperator: DateOperator.after,
      path: '$.startDate',
    });
    expect(sql).toBe('"endDate" > "startDate"');
    expect(params).toEqual([]);
  });

  it('$.field with alias uses alias-qualified ref column', () => {
    const { sql, params } = toSql(
      { field: 'endDate', operator: Operator.greaterThan, path: '$.startDate' },
      { alias: 't0' },
    );
    expect(sql).toBe('"endDate" > "t0"."startDate"');
    expect(params).toEqual([]);
  });
});

// ─── path ref: context.path ───────────────────────────────────────────────────
describe('toSql path ref: context.path', () => {
  it('context.path → resolves value and emits as param', () => {
    const { sql, params } = toSql(
      { field: 'userId', operator: Operator.equals, path: 'currentUser.id' },
      { context: { currentUser: { id: 'u-123' } } },
    );
    expect(sql).toBe('"userId" = $1');
    expect(params).toEqual(['u-123']);
  });

  it('nested context.path', () => {
    const { sql, params } = toSql(
      { field: 'orgId', operator: Operator.equals, path: 'session.org.id' },
      { context: { session: { org: { id: 'org-abc' } } } },
    );
    expect(sql).toBe('"orgId" = $1');
    expect(params).toEqual(['org-abc']);
  });

  it('date rule: context.path → param', () => {
    const since = new Date('2024-01-01');
    const { sql, params } = toSql(
      { field: 'createdAt', dateOperator: DateOperator.after, path: 'filters.since' },
      { context: { filters: { since } } },
    );
    expect(sql).toBe('"createdAt" > $1');
    expect(params).toEqual([since]);
  });

  it('context.path without context → throws', () => {
    expect(() =>
      toSql({ field: 'userId', operator: Operator.equals, path: 'currentUser.id' }),
    ).toThrow('context');
  });
});

// ─── Map-aware: forward relation JOIN ────────────────────────────────────────
describe('toSql map-aware JOINs (forward relation)', () => {
  it('traverses forward relation and qualifies column', () => {
    const { sql, params, joins } = toSql(
      { field: 'author.email', operator: Operator.equals, value: 'a@b.com' },
      { map: blogMap, model: 'Post', alias: 't0' },
    );
    expect(sql).toBe('"t1"."email" = $1');
    expect(params).toEqual(['a@b.com']);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toBe('LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"');
  });

  it('qualifies root scalar without joining', () => {
    const { sql, joins } = toSql(
      { field: 'title', operator: Operator.equals, value: 'Hello' },
      { map: blogMap, model: 'Post', alias: 't0' },
    );
    expect(sql).toBe('"t0"."title" = $1');
    expect(joins).toHaveLength(0);
  });
});

// ─── Map-aware: back-relation JOIN ───────────────────────────────────────────
describe('toSql map-aware JOINs (back-relation)', () => {
  it('traverses back-relation by finding reverse FK on target', () => {
    const { sql, joins } = toSql(
      { field: 'posts.title', operator: Operator.contains, value: 'Hello' },
      { map: blogMap, model: 'User', alias: 't0' },
    );
    expect(sql).toBe('"t1"."title" LIKE $1');
    expect(joins[0]).toBe('LEFT JOIN "Post" AS "t1" ON "t1"."authorId" = "t0"."id"');
  });
});

// ─── JOIN deduplication ───────────────────────────────────────────────────────
describe('toSql JOIN deduplication', () => {
  it('same relation traversed twice → single JOIN', () => {
    const { sql, joins } = toSql(
      {
        all: [
          { field: 'author.email', operator: Operator.equals, value: 'a@b.com' },
          { field: 'author.name', operator: Operator.contains, value: 'Alice' },
        ],
      },
      { map: blogMap, model: 'Post', alias: 't0' },
    );
    expect(joins).toHaveLength(1);
    expect(joins[0]).toBe('LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"');
    expect(sql).toBe('("t1"."email" = $1 AND "t1"."name" LIKE $2)');
  });
});

// ─── Map-aware: JSON field mid-path ──────────────────────────────────────────
describe('toSql map-aware JSON path with alias', () => {
  it('json field at root → qualified JSON path expression', () => {
    const { sql, params, joins } = toSql(
      { field: 'metadata.theme', operator: Operator.equals, value: 'dark' },
      { map: blogMap, model: 'User', alias: 't0' },
    );
    expect(sql).toBe(`"t0"."metadata"->>'theme' = $1`);
    expect(params).toEqual(['dark']);
    expect(joins).toHaveLength(0);
  });

  it('nested json path → qualified multi-level JSON expression', () => {
    const { sql } = toSql(
      { field: 'settings.display.mode', operator: Operator.equals, value: 'compact' },
      { map: blogMap, model: 'Post', alias: 't0' },
    );
    expect(sql).toBe(`"t0"."settings"->'display'->>'mode' = $1`);
  });

  it('json field after relation → joined alias + JSON path', () => {
    const { sql, joins } = toSql(
      { field: 'author.metadata.theme', operator: Operator.equals, value: 'dark' },
      { map: blogMap, model: 'Post', alias: 't0' },
    );
    expect(joins).toHaveLength(1);
    expect(joins[0]).toBe('LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"');
    expect(sql).toBe(`"t1"."metadata"->>'theme' = $1`);
  });
});

// ─── Multiple relations between same two models ───────────────────────────────
describe('toSql multiple relations between same two models', () => {
  it('forward relation author → correct authorId FK in JOIN', () => {
    const { joins } = toSql(
      { field: 'author.name', operator: Operator.equals, value: 'Alice' },
      { map: multiRelMap, model: 'Post', alias: 't0' },
    );
    expect(joins).toHaveLength(1);
    expect(joins[0]).toBe('LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"');
  });

  it('forward relation editor → correct editorId FK in JOIN', () => {
    const { joins } = toSql(
      { field: 'editor.name', operator: Operator.equals, value: 'Bob' },
      { map: multiRelMap, model: 'Post', alias: 't0' },
    );
    expect(joins).toHaveLength(1);
    expect(joins[0]).toBe('LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."editorId"');
  });

  it('both author and editor in same condition → two distinct JOINs', () => {
    const { sql, joins } = toSql(
      {
        all: [
          { field: 'author.name', operator: Operator.equals, value: 'Alice' },
          { field: 'editor.name', operator: Operator.equals, value: 'Bob' },
        ],
      },
      { map: multiRelMap, model: 'Post', alias: 't0' },
    );
    expect(joins).toHaveLength(2);
    expect(joins[0]).toBe('LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"');
    expect(joins[1]).toBe('LEFT JOIN "User" AS "t2" ON "t2"."id" = "t0"."editorId"');
    expect(sql).toBe('("t1"."name" = $1 AND "t2"."name" = $2)');
  });
});

// ─── Composite FK JOINs ───────────────────────────────────────────────────────
describe('toSql composite FK JOINs', () => {
  it('composite forward relation → multi-condition ON clause', () => {
    const { sql, joins } = toSql(
      { field: 'order.id', operator: Operator.equals, value: 'ord-1' },
      { map: compositeFkMap, model: 'OrderItem', alias: 't0' },
    );
    expect(joins).toHaveLength(1);
    expect(joins[0]).toBe(
      'LEFT JOIN "Order" AS "t1" ON "t1"."id" = "t0"."orderId" AND "t1"."code" = "t0"."productId"',
    );
    expect(sql).toBe('"t1"."id" = $1');
  });
});

// ─── No map falls back to existing behavior ───────────────────────────────────
describe('toSql without map falls back to existing behavior', () => {
  it('dot path treated as JSON path (original behavior)', () => {
    const { sql } = toSql({ field: 'data.theme', operator: Operator.equals, value: 'dark' });
    expect(sql).toBe(`"data"->>'theme' = $1`);
  });

  it('nested dot path treated as JSON path', () => {
    const { sql } = toSql({ field: 'settings.display.mode', operator: Operator.equals, value: 'compact' });
    expect(sql).toBe(`"settings"->'display'->>'mode' = $1`);
  });
});
