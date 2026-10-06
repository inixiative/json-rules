import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap } from '../index';
import { validateRule } from '../index';
import { prefixConditionFields } from '../src/lens/applyLens';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { createLens } from '../src/lens/createLens';
import { describeRule } from '../src/lens/describeRule';

// The grammar gates an offset where it can mean something, and the lens gates every ref an
// offset or magnitude names exactly as it gates `path`.

const rule = (r: object): Condition => r as never;

const codes = (r: object, target?: 'check' | 'toSql' | 'toPrisma') =>
  validateRule(rule(r), target ? { target } : undefined).errors.map((e) => e.code);

describe('validateRule — offset', () => {
  test('accepts an offset on path and bind', () => {
    for (const r of [
      { field: 'score', operator: 'greaterThanEquals', path: '$.avg', offset: 5 },
      { field: 'score', operator: 'greaterThanEquals', path: 'avg', offset: -5 },
      { field: 'score', operator: 'between', bind: 'range', offset: { path: '$.delta' } },
      { field: 'ts', dateOperator: 'before', path: '$.anchor', offset: { ago: { days: 7 } } },
      {
        field: 'ts',
        dateOperator: 'between',
        bind: 'window',
        offset: { ahead: { days: { path: '$.grace' } } },
      },
    ]) {
      expect(codes(r)).toEqual([]);
    }
  });

  test('an offset on a literal value is rejected', () => {
    expect(codes({ field: 'score', operator: 'equals', value: 1, offset: 2 })).toEqual([
      'unexpected_offset',
    ]);
    expect(
      codes({
        field: 'ts',
        dateOperator: 'before',
        value: '2026-01-01',
        offset: { ago: { days: 1 } },
      }),
    ).toEqual(['unexpected_offset']);
  });

  test('an offset on an operator that has no point to shift is rejected', () => {
    expect(codes({ field: 'tag', operator: 'in', path: 'tags', offset: 1 })).toEqual([
      'unsupported_offset_operator',
    ]);
    expect(codes({ field: 'name', operator: 'contains', path: 'q', offset: 1 })).toEqual([
      'unsupported_offset_operator',
    ]);
  });

  test('a field offset is a number or a path', () => {
    expect(codes({ field: 'score', operator: 'equals', path: 'a', offset: '5' })).toEqual([
      'invalid_offset',
    ]);
    expect(
      codes({ field: 'score', operator: 'equals', path: 'a', offset: { ago: { days: 1 } } }),
    ).toEqual(['invalid_offset']);
  });

  test('a date offset is ago or ahead', () => {
    expect(codes({ field: 'ts', dateOperator: 'before', path: 'a', offset: { days: 7 } })).toEqual([
      'invalid_offset',
    ]);
    expect(codes({ field: 'ts', dateOperator: 'before', path: 'a', offset: 7 })).toEqual([
      'invalid_offset',
    ]);
    expect(
      codes({ field: 'ts', dateOperator: 'before', path: 'a', offset: { this: 'month' } }),
    ).toEqual(['invalid_offset']);
  });

  test('a date offset carries valid units', () => {
    expect(
      codes({ field: 'ts', dateOperator: 'before', path: 'a', offset: { ago: { fortnights: 1 } } }),
    ).toEqual(['invalid_relative_unit']);
    expect(
      codes({ field: 'ts', dateOperator: 'before', path: 'a', offset: { ago: { days: -1 } } }),
    ).toEqual(['invalid_relative_magnitude']);
  });
});

describe('validateRule — path magnitudes', () => {
  test('a magnitude is a non-negative number or { path }', () => {
    expect(
      codes({ field: 'ts', dateOperator: 'before', value: { ago: { seconds: { path: '$.s' } } } }),
    ).toEqual([]);
    expect(
      codes({ field: 'ts', dateOperator: 'before', value: { ago: { seconds: { path: 3 } } } }),
    ).toEqual(['invalid_relative_magnitude']);
    expect(
      codes({ field: 'ts', dateOperator: 'before', value: { ago: { seconds: { bind: 's' } } } }),
    ).toEqual(['invalid_relative_magnitude']);
  });

  test('a row ref in an offset or magnitude is gated per target like path', () => {
    const rowMagnitude = {
      field: 'ts',
      dateOperator: 'before',
      value: { ago: { seconds: { path: '$.s' } } },
    };
    const rowOffset = { field: 'score', operator: 'equals', path: 'a', offset: { path: '$.d' } };
    expect(codes(rowMagnitude, 'toSql')).toEqual([]);
    expect(codes(rowMagnitude, 'toPrisma')).toEqual(['unsupported_prisma_path']);
    expect(codes(rowOffset, 'toPrisma')).toEqual(['unsupported_prisma_path']);
    expect(
      codes({ field: 'score', operator: 'equals', path: 'a', offset: { path: '$$.d' } }, 'toSql'),
    ).toEqual(['scope_out_of_bounds', 'unsupported_sql_path']);
  });
});

const map: FieldMap = {
  models: {
    Incident: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        score: { kind: 'scalar', type: 'Int' },
        note: { kind: 'scalar', type: 'String' },
        lastBreachedAt: { kind: 'scalar', type: 'DateTime' },
        rule: { kind: 'object', type: 'AlertRule', isList: false },
      },
    },
    AlertRule: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        autoResolveAfterSeconds: { kind: 'scalar', type: 'Int' },
        name: { kind: 'scalar', type: 'String' },
        secret: { kind: 'scalar', type: 'Int' },
      },
    },
  },
};

const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Incident' });
const narrowed = {
  parent: lens,
  root: { relations: { rule: { omits: ['secret'] } } },
};

const gate = (r: object, l: Parameters<typeof checkRuleAgainstLens>[1] = lens) =>
  checkRuleAgainstLens(rule(r), l);

const autoResolve = {
  field: 'lastBreachedAt',
  dateOperator: 'before',
  value: { ago: { seconds: { path: '$.rule.autoResolveAfterSeconds' } } },
};

describe('lens gate — offset and magnitude refs', () => {
  test('the auto-resolve guard resolves through the lens', () => {
    expect(gate(autoResolve)).toEqual({ ok: true, violations: [] });
  });

  test('a magnitude ref outside the narrowed lens is a violation', () => {
    const result = gate(
      { ...autoResolve, value: { ago: { seconds: { path: '$.rule.secret' } } } },
      narrowed,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.path).toBe('$.rule.secret');
  });

  test('an offset ref outside the narrowed lens is a violation', () => {
    const result = gate(
      {
        field: 'score',
        operator: 'greaterThanEquals',
        path: '$.rule.autoResolveAfterSeconds',
        offset: { path: '$.rule.secret' },
      },
      narrowed,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.path).toBe('$.rule.secret');
  });

  test('a magnitude must name a number', () => {
    const result = gate({ ...autoResolve, value: { ago: { seconds: { path: '$.rule.name' } } } });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.path).toBe('$.rule.name');
  });

  test('a numeric offset needs a numeric field', () => {
    const result = gate({ field: 'note', operator: 'equals', path: '$.note', offset: 1 });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.path).toBe('note');
  });

  test('a numeric offset on a numeric field passes', () => {
    expect(gate({ field: 'score', operator: 'equals', path: '$.score', offset: 1 }).ok).toBe(true);
  });
});

describe('describeRule — offset and magnitude refs restrict targets like path', () => {
  test('a row magnitude drops toPrisma', () => {
    expect(describeRule(rule(autoResolve), lens).supportedTargets).toEqual(['check', 'toSql']);
  });

  test('a row offset ref drops toPrisma', () => {
    expect(
      describeRule(
        rule({ field: 'score', operator: 'equals', path: 'x', offset: { path: '$.score' } }),
        lens,
      ).supportedTargets,
    ).toEqual(['check', 'toSql']);
  });

  test('context refs keep every target', () => {
    expect(
      describeRule(
        rule({ field: 'score', operator: 'equals', path: 'x', offset: { path: 'y' } }),
        lens,
      ).supportedTargets,
    ).toEqual(['check', 'toPrisma', 'toSql']);
  });
});

describe('applyLens refuses to re-root a grant with an offset or magnitude ref', () => {
  test('a magnitude ref', () => {
    expect(() => prefixConditionFields(rule(autoResolve), 'incidents')).toThrow('path reference');
  });

  test('an offset ref on a bind', () => {
    expect(() =>
      prefixConditionFields(
        rule({ field: 'score', operator: 'equals', bind: 'b', offset: { path: '$.score' } }),
        'incidents',
      ),
    ).toThrow('path reference');
  });

  test('a literal offset on a bind re-roots', () => {
    expect(
      prefixConditionFields(
        rule({ field: 'score', operator: 'equals', bind: 'b', offset: 1 }),
        'incidents',
      ),
    ).toEqual(rule({ field: 'incidents.score', operator: 'equals', bind: 'b', offset: 1 }));
  });
});
