import { describe, it, expect } from 'bun:test';
import { toSql, Operator, DateOperator, ArrayOperator } from '../index';

describe('toSql', () => {
  describe('field operators', () => {
    it('equals', () => {
      const { sql, params } = toSql({ field: 'status', operator: Operator.equals, value: 'active' });
      expect(sql).toBe('"status" = $1');
      expect(params).toEqual(['active']);
    });

    it('equals null', () => {
      const { sql, params } = toSql({ field: 'deletedAt', operator: Operator.equals, value: null });
      expect(sql).toBe('"deletedAt" IS NULL');
      expect(params).toEqual([]);
    });

    it('notEquals', () => {
      const { sql, params } = toSql({ field: 'role', operator: Operator.notEquals, value: 'guest' });
      expect(sql).toBe('"role" <> $1');
      expect(params).toEqual(['guest']);
    });

    it('notEquals null', () => {
      const { sql, params } = toSql({ field: 'email', operator: Operator.notEquals, value: null });
      expect(sql).toBe('"email" IS NOT NULL');
      expect(params).toEqual([]);
    });

    it('lessThan', () => {
      const { sql, params } = toSql({ field: 'age', operator: Operator.lessThan, value: 18 });
      expect(sql).toBe('"age" < $1');
      expect(params).toEqual([18]);
    });

    it('lessThanEquals', () => {
      const { sql, params } = toSql({ field: 'price', operator: Operator.lessThanEquals, value: 100 });
      expect(sql).toBe('"price" <= $1');
      expect(params).toEqual([100]);
    });

    it('greaterThan', () => {
      const { sql, params } = toSql({ field: 'score', operator: Operator.greaterThan, value: 50 });
      expect(sql).toBe('"score" > $1');
      expect(params).toEqual([50]);
    });

    it('greaterThanEquals', () => {
      const { sql, params } = toSql({ field: 'rating', operator: Operator.greaterThanEquals, value: 4.5 });
      expect(sql).toBe('"rating" >= $1');
      expect(params).toEqual([4.5]);
    });

    it('in', () => {
      const { sql, params } = toSql({ field: 'status', operator: Operator.in, value: ['active', 'pending'] });
      expect(sql).toBe('"status" = ANY($1)');
      expect(params).toEqual([['active', 'pending']]);
    });

    it('in empty array', () => {
      const { sql, params } = toSql({ field: 'status', operator: Operator.in, value: [] });
      expect(sql).toBe('FALSE');
      expect(params).toEqual([]);
    });

    it('notIn', () => {
      const { sql, params } = toSql({ field: 'type', operator: Operator.notIn, value: ['spam', 'deleted'] });
      expect(sql).toBe('"type" <> ALL($1)');
      expect(params).toEqual([['spam', 'deleted']]);
    });

    it('notIn empty array', () => {
      const { sql, params } = toSql({ field: 'type', operator: Operator.notIn, value: [] });
      expect(sql).toBe('TRUE');
      expect(params).toEqual([]);
    });

    it('contains', () => {
      const { sql, params } = toSql({ field: 'name', operator: Operator.contains, value: 'test' });
      expect(sql).toBe('"name" LIKE $1');
      expect(params).toEqual(['%test%']);
    });

    it('notContains', () => {
      const { sql, params } = toSql({ field: 'email', operator: Operator.notContains, value: 'spam' });
      expect(sql).toBe('"email" NOT LIKE $1');
      expect(params).toEqual(['%spam%']);
    });

    it('startsWith', () => {
      const { sql, params } = toSql({ field: 'name', operator: Operator.startsWith, value: 'Admin' });
      expect(sql).toBe('"name" LIKE $1');
      expect(params).toEqual(['Admin%']);
    });

    it('endsWith', () => {
      const { sql, params } = toSql({ field: 'email', operator: Operator.endsWith, value: '@gmail.com' });
      expect(sql).toBe('"email" LIKE $1');
      expect(params).toEqual(['%@gmail.com']);
    });

    it('matches (regex)', () => {
      const { sql, params } = toSql({ field: 'phone', operator: Operator.matches, value: '^\\+1' });
      expect(sql).toBe('"phone" ~ $1');
      expect(params).toEqual(['^\\+1']);
    });

    it('notMatches', () => {
      const { sql, params } = toSql({ field: 'code', operator: Operator.notMatches, value: 'test' });
      expect(sql).toBe('"code" !~ $1');
      expect(params).toEqual(['test']);
    });

    it('between', () => {
      const { sql, params } = toSql({ field: 'age', operator: Operator.between, value: [18, 65] });
      expect(sql).toBe('"age" BETWEEN $1 AND $2');
      expect(params).toEqual([18, 65]);
    });

    it('notBetween', () => {
      const { sql, params } = toSql({ field: 'score', operator: Operator.notBetween, value: [0, 10] });
      expect(sql).toBe('"score" NOT BETWEEN $1 AND $2');
      expect(params).toEqual([0, 10]);
    });

    it('isEmpty', () => {
      const { sql, params } = toSql({ field: 'bio', operator: Operator.isEmpty, value: true });
      expect(sql).toBe('("bio" IS NULL OR "bio" = \'\')');
      expect(params).toEqual([]);
    });

    it('notEmpty', () => {
      const { sql, params } = toSql({ field: 'name', operator: Operator.notEmpty, value: true });
      expect(sql).toBe('("name" IS NOT NULL AND "name" <> \'\')');
      expect(params).toEqual([]);
    });

    it('exists', () => {
      const { sql, params } = toSql({ field: 'avatar', operator: Operator.exists, value: true });
      expect(sql).toBe('"avatar" IS NOT NULL');
      expect(params).toEqual([]);
    });

    it('notExists', () => {
      const { sql, params } = toSql({ field: 'deletedAt', operator: Operator.notExists, value: true });
      expect(sql).toBe('"deletedAt" IS NULL');
      expect(params).toEqual([]);
    });
  });

  describe('JSON path fields', () => {
    it('single level JSON path', () => {
      const { sql, params } = toSql({ field: 'data.theme', operator: Operator.equals, value: 'dark' });
      expect(sql).toBe('"data"->>\'theme\' = $1');
      expect(params).toEqual(['dark']);
    });

    it('nested JSON path', () => {
      const { sql, params } = toSql({ field: 'settings.display.mode', operator: Operator.equals, value: 'compact' });
      expect(sql).toBe('"settings"->\'display\'->>\'mode\' = $1');
      expect(params).toEqual(['compact']);
    });
  });

  describe('date operators', () => {
    it('before', () => {
      const date = new Date('2024-01-01');
      const { sql, params } = toSql({ field: 'createdAt', dateOperator: DateOperator.before, value: date });
      expect(sql).toBe('"createdAt" < $1');
      expect(params).toEqual([date]);
    });

    it('after', () => {
      const date = new Date('2024-01-01');
      const { sql, params } = toSql({ field: 'updatedAt', dateOperator: DateOperator.after, value: date });
      expect(sql).toBe('"updatedAt" > $1');
      expect(params).toEqual([date]);
    });

    it('onOrBefore', () => {
      const date = new Date('2024-12-31');
      const { sql, params } = toSql({ field: 'expiresAt', dateOperator: DateOperator.onOrBefore, value: date });
      expect(sql).toBe('"expiresAt" <= $1');
      expect(params).toEqual([date]);
    });

    it('onOrAfter', () => {
      const date = new Date('2024-01-01');
      const { sql, params } = toSql({ field: 'startDate', dateOperator: DateOperator.onOrAfter, value: date });
      expect(sql).toBe('"startDate" >= $1');
      expect(params).toEqual([date]);
    });

    it('between dates', () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');
      const { sql, params } = toSql({ field: 'eventDate', dateOperator: DateOperator.between, value: [start, end] });
      expect(sql).toBe('"eventDate" BETWEEN $1 AND $2');
      expect(params).toEqual([start, end]);
    });

    it('dayIn', () => {
      const { sql, params } = toSql({ field: 'scheduledAt', dateOperator: DateOperator.dayIn, value: ['monday', 'wednesday', 'friday'] });
      expect(sql).toBe('EXTRACT(DOW FROM "scheduledAt") = ANY($1)');
      expect(params).toEqual([[1, 3, 5]]);
    });

    it('dayNotIn', () => {
      const { sql, params } = toSql({ field: 'deliveryDate', dateOperator: DateOperator.dayNotIn, value: ['saturday', 'sunday'] });
      expect(sql).toBe('EXTRACT(DOW FROM "deliveryDate") <> ALL($1)');
      expect(params).toEqual([[6, 0]]);
    });
  });

  describe('array operators', () => {
    describe('jsonb (default)', () => {
      it('empty', () => {
        const { sql, params } = toSql({ field: 'tags', arrayOperator: ArrayOperator.empty });
        expect(sql).toBe('("tags" IS NULL OR jsonb_array_length("tags") = 0)');
        expect(params).toEqual([]);
      });

      it('notEmpty', () => {
        const { sql, params } = toSql({ field: 'items', arrayOperator: ArrayOperator.notEmpty });
        expect(sql).toBe('("items" IS NOT NULL AND jsonb_array_length("items") > 0)');
        expect(params).toEqual([]);
      });
    });

    describe('native (TEXT[], INT[], etc.)', () => {
      it('empty', () => {
        const { sql, params } = toSql({ field: 'tags', arrayOperator: ArrayOperator.empty, arrayType: 'native' });
        expect(sql).toBe('("tags" IS NULL OR array_length("tags", 1) IS NULL)');
        expect(params).toEqual([]);
      });

      it('notEmpty', () => {
        const { sql, params } = toSql({ field: 'items', arrayOperator: ArrayOperator.notEmpty, arrayType: 'native' });
        expect(sql).toBe('("items" IS NOT NULL AND array_length("items", 1) IS NOT NULL)');
        expect(params).toEqual([]);
      });
    });

    it('throws for complex array operators', () => {
      expect(() => toSql({ field: 'items', arrayOperator: ArrayOperator.all, condition: { field: 'active', operator: Operator.equals, value: true } }))
        .toThrow('not supported in SQL');
    });
  });

  describe('logical operators', () => {
    it('all (AND)', () => {
      const { sql, params } = toSql({
        all: [
          { field: 'status', operator: Operator.equals, value: 'active' },
          { field: 'verified', operator: Operator.equals, value: true },
        ],
      });
      expect(sql).toBe('("status" = $1 AND "verified" = $2)');
      expect(params).toEqual(['active', true]);
    });

    it('any (OR)', () => {
      const { sql, params } = toSql({
        any: [
          { field: 'role', operator: Operator.equals, value: 'admin' },
          { field: 'role', operator: Operator.equals, value: 'superadmin' },
        ],
      });
      expect(sql).toBe('("role" = $1 OR "role" = $2)');
      expect(params).toEqual(['admin', 'superadmin']);
    });

    it('empty all', () => {
      const { sql, params } = toSql({ all: [] });
      expect(sql).toBe('TRUE');
      expect(params).toEqual([]);
    });

    it('empty any', () => {
      const { sql, params } = toSql({ any: [] });
      expect(sql).toBe('FALSE');
      expect(params).toEqual([]);
    });

    it('if/then', () => {
      const { sql, params } = toSql({
        if: { field: 'type', operator: Operator.equals, value: 'premium' },
        then: { field: 'credits', operator: Operator.greaterThan, value: 0 },
      });
      expect(sql).toBe('(NOT("type" = $1) OR "credits" > $2)');
      expect(params).toEqual(['premium', 0]);
    });

    it('if/then/else', () => {
      const { sql, params } = toSql({
        if: { field: 'type', operator: Operator.equals, value: 'trial' },
        then: { field: 'daysLeft', operator: Operator.greaterThan, value: 0 },
        else: { field: 'subscribed', operator: Operator.equals, value: true },
      });
      // Reuses $1 for the if clause in both branches (efficient)
      expect(sql).toBe('((NOT("type" = $1) OR "daysLeft" > $2) AND ("type" = $1 OR "subscribed" = $3))');
      expect(params).toEqual(['trial', 0, true]);
    });

    it('nested logical operators', () => {
      const { sql, params } = toSql({
        all: [
          { field: 'deletedAt', operator: Operator.equals, value: null },
          {
            any: [
              { field: 'public', operator: Operator.equals, value: true },
              { field: 'ownerId', operator: Operator.equals, value: 'user123' },
            ],
          },
        ],
      });
      expect(sql).toBe('("deletedAt" IS NULL AND ("public" = $1 OR "ownerId" = $2))');
      expect(params).toEqual([true, 'user123']);
    });
  });

  describe('boolean conditions', () => {
    it('true', () => {
      const { sql, params } = toSql(true);
      expect(sql).toBe('TRUE');
      expect(params).toEqual([]);
    });

    it('false', () => {
      const { sql, params } = toSql(false);
      expect(sql).toBe('FALSE');
      expect(params).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('throws for between without array', () => {
      expect(() => toSql({ field: 'age', operator: Operator.between, value: 18 }))
        .toThrow('between operator requires an array of two values');
    });

    it('throws for unknown day name', () => {
      expect(() => toSql({ field: 'date', dateOperator: DateOperator.dayIn, value: ['notaday'] }))
        .toThrow('Unknown day name: notaday');
    });
  });
});
