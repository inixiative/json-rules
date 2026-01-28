import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { toSql, Operator, DateOperator } from '../index';

describe('toSql integration', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        age INT,
        role TEXT,
        status TEXT,
        verified BOOLEAN DEFAULT FALSE,
        credits INT DEFAULT 0,
        "deletedAt" TIMESTAMP,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        settings JSONB DEFAULT '{}'
      )
    `);

    await db.exec(`
      INSERT INTO users (name, email, age, role, status, verified, credits, "deletedAt", settings) VALUES
        ('Alice', 'alice@example.com', 30, 'admin', 'active', true, 100, NULL, '{"theme": "dark", "notifications": {"email": true}}'),
        ('Bob', 'bob@test.org', 25, 'user', 'active', true, 50, NULL, '{"theme": "light"}'),
        ('Charlie', 'charlie@example.com', 17, 'user', 'pending', false, 0, NULL, '{}'),
        ('Deleted User', 'deleted@example.com', 40, 'user', 'inactive', false, 0, '2024-01-01', '{}'),
        ('Eve', 'eve@gmail.com', 35, 'moderator', 'active', true, 75, NULL, '{"theme": "dark"}')
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  const query = async (rule: Parameters<typeof toSql>[0]) => {
    const { sql, params } = toSql(rule);
    const result = await db.query(`SELECT name FROM users WHERE ${sql} ORDER BY name`, params);
    return result.rows.map((r: any) => r.name);
  };

  describe('field operators', () => {
    it('equals', async () => {
      const names = await query({ field: 'role', operator: Operator.equals, value: 'admin' });
      expect(names).toEqual(['Alice']);
    });

    it('equals null', async () => {
      const names = await query({ field: 'deletedAt', operator: Operator.equals, value: null });
      expect(names).toEqual(['Alice', 'Bob', 'Charlie', 'Eve']);
    });

    it('notEquals', async () => {
      const names = await query({ field: 'status', operator: Operator.notEquals, value: 'active' });
      expect(names).toEqual(['Charlie', 'Deleted User']);
    });

    it('greaterThan', async () => {
      const names = await query({ field: 'age', operator: Operator.greaterThan, value: 30 });
      expect(names).toEqual(['Deleted User', 'Eve']);
    });

    it('lessThanEquals', async () => {
      const names = await query({ field: 'age', operator: Operator.lessThanEquals, value: 25 });
      expect(names).toEqual(['Bob', 'Charlie']);
    });

    it('in', async () => {
      const names = await query({ field: 'role', operator: Operator.in, value: ['admin', 'moderator'] });
      expect(names).toEqual(['Alice', 'Eve']);
    });

    it('notIn', async () => {
      const names = await query({ field: 'status', operator: Operator.notIn, value: ['pending', 'inactive'] });
      expect(names).toEqual(['Alice', 'Bob', 'Eve']);
    });

    it('contains', async () => {
      const names = await query({ field: 'email', operator: Operator.contains, value: 'example' });
      expect(names).toEqual(['Alice', 'Charlie', 'Deleted User']);
    });

    it('startsWith', async () => {
      const names = await query({ field: 'email', operator: Operator.startsWith, value: 'e' });
      expect(names).toEqual(['Eve']);
    });

    it('endsWith', async () => {
      const names = await query({ field: 'email', operator: Operator.endsWith, value: '.org' });
      expect(names).toEqual(['Bob']);
    });

    it('matches (regex)', async () => {
      const names = await query({ field: 'email', operator: Operator.matches, value: '^[a-c].*@example' });
      expect(names).toEqual(['Alice', 'Charlie']);
    });

    it('between', async () => {
      const names = await query({ field: 'age', operator: Operator.between, value: [25, 35] });
      expect(names).toEqual(['Alice', 'Bob', 'Eve']);
    });

    it('exists (IS NOT NULL)', async () => {
      const names = await query({ field: 'deletedAt', operator: Operator.exists, value: true });
      expect(names).toEqual(['Deleted User']);
    });

    it('notExists (IS NULL)', async () => {
      const names = await query({ field: 'deletedAt', operator: Operator.notExists, value: true });
      expect(names).toEqual(['Alice', 'Bob', 'Charlie', 'Eve']);
    });
  });

  describe('JSON path fields', () => {
    it('queries nested JSON field', async () => {
      const names = await query({ field: 'settings.theme', operator: Operator.equals, value: 'dark' });
      expect(names).toEqual(['Alice', 'Eve']);
    });
  });

  describe('logical operators', () => {
    it('all (AND)', async () => {
      const names = await query({
        all: [
          { field: 'status', operator: Operator.equals, value: 'active' },
          { field: 'verified', operator: Operator.equals, value: true },
          { field: 'credits', operator: Operator.greaterThanEquals, value: 50 },
        ],
      });
      expect(names).toEqual(['Alice', 'Bob', 'Eve']);
    });

    it('any (OR)', async () => {
      const names = await query({
        any: [
          { field: 'role', operator: Operator.equals, value: 'admin' },
          { field: 'age', operator: Operator.lessThan, value: 20 },
        ],
      });
      expect(names).toEqual(['Alice', 'Charlie']);
    });

    it('nested logical', async () => {
      const names = await query({
        all: [
          { field: 'deletedAt', operator: Operator.equals, value: null },
          {
            any: [
              { field: 'role', operator: Operator.equals, value: 'admin' },
              { field: 'credits', operator: Operator.greaterThan, value: 50 },
            ],
          },
        ],
      });
      expect(names).toEqual(['Alice', 'Eve']);
    });

    it('if/then', async () => {
      // If role is admin, must have credits > 50
      const names = await query({
        if: { field: 'role', operator: Operator.equals, value: 'admin' },
        then: { field: 'credits', operator: Operator.greaterThan, value: 50 },
      });
      // Alice (admin with 100 credits) - passes
      // Bob (user) - if condition false, passes
      // Charlie (user) - if condition false, passes
      // Deleted User (user) - if condition false, passes
      // Eve (moderator) - if condition false, passes
      expect(names).toEqual(['Alice', 'Bob', 'Charlie', 'Deleted User', 'Eve']);
    });
  });

  describe('real-world scenarios', () => {
    it('active non-deleted users', async () => {
      const names = await query({
        all: [
          { field: 'status', operator: Operator.equals, value: 'active' },
          { field: 'deletedAt', operator: Operator.equals, value: null },
        ],
      });
      expect(names).toEqual(['Alice', 'Bob', 'Eve']);
    });

    it('users eligible for premium (verified + credits >= 50)', async () => {
      const names = await query({
        all: [
          { field: 'verified', operator: Operator.equals, value: true },
          { field: 'credits', operator: Operator.greaterThanEquals, value: 50 },
        ],
      });
      expect(names).toEqual(['Alice', 'Bob', 'Eve']);
    });

    it('admin or moderator with dark theme', async () => {
      const names = await query({
        all: [
          { field: 'role', operator: Operator.in, value: ['admin', 'moderator'] },
          { field: 'settings.theme', operator: Operator.equals, value: 'dark' },
        ],
      });
      expect(names).toEqual(['Alice', 'Eve']);
    });
  });
});
