import { describe, expect, test } from 'bun:test';
import {
  check,
  coerceRule,
  createLens,
  describeRule,
  narrowRule,
  projectLens,
  validateRuleInLens,
} from '../index';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        firstName: { kind: 'scalar', type: 'String' },
        age: { kind: 'scalar', type: 'Int' },
        status: { kind: 'enum', type: 'Status' },
        metadata: { kind: 'scalar', type: 'Json' },
        // A Json column that also carries a declared value set — the set describes the
        // column itself and must not gate anything below the boundary.
        settings: { kind: 'scalar', type: 'Json', values: ['a', 'b'] },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        payload: { kind: 'scalar', type: 'Json' },
      },
    },
  },
  enums: { Status: ['active', 'banned'] },
};

const lens = createLens({ maps: { app: map }, mapName: 'app', model: 'User' });

describe('validateRuleInLens — Json sub-paths', () => {
  test('a dotted sub-path into a visible Json column resolves (no violation)', () => {
    const res = validateRuleInLens(
      { all: [{ field: 'metadata.theme', operator: 'equals', value: 'dark' }] },
      lens,
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test('a deeper sub-path also resolves', () => {
    const res = validateRuleInLens(
      { all: [{ field: 'metadata.display.mode', operator: 'equals', value: 'dark' }] },
      lens,
    );
    expect(res.ok).toBe(true);
  });

  test('the bare Json column resolves', () => {
    const res = validateRuleInLens({ all: [{ field: 'metadata', operator: 'exists' }] }, lens);
    expect(res.ok).toBe(true);
  });

  test('a sub-path under a non-existent column still fails', () => {
    const res = validateRuleInLens(
      { all: [{ field: 'nope.theme', operator: 'equals', value: 'x' }] },
      lens,
    );
    expect(res.ok).toBe(false);
  });

  test('a path traverses declared relations and then enters Json', () => {
    const res = validateRuleInLens(
      { field: 'posts.payload.blocks.0.kind', operator: 'equals', value: 'hero' },
      lens,
    );
    expect(res.ok).toBe(true);
  });

  test('open-endedness is exclusive to the Json boundary — non-Json scalars reject sub-paths', () => {
    for (const field of ['firstName.foo', 'age.foo', 'status.foo', 'posts.title.foo']) {
      const res = validateRuleInLens({ field, operator: 'equals', value: 'x' }, lens);
      expect(res.ok).toBe(false);
      expect(res.errors[0].path).toBe(field);
    }
  });

  test('no relation traversal resumes below the boundary', () => {
    // `posts` is a declared relation on User, but under `metadata` it is just a JSON key.
    const res = validateRuleInLens(
      { field: 'metadata.posts.title', operator: 'equals', value: 'x' },
      lens,
    );
    expect(res.ok).toBe(true);
  });
});

describe('validateRuleInLens — value sets stop at the Json boundary', () => {
  test("the column's declared values still gate the bare column", () => {
    const res = validateRuleInLens({ field: 'settings', operator: 'equals', value: 'zzz' }, lens);
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toContain('not in the allowed set');
  });

  test("the column's declared values do not gate its sub-paths", () => {
    const res = validateRuleInLens(
      { field: 'settings.theme', operator: 'equals', value: 'zzz' },
      lens,
    );
    expect(res.ok).toBe(true);
  });

  test('enumPicks on the Json column do not gate its sub-paths', () => {
    const narrowed = { parent: lens, root: { enumPicks: { settings: ['a'] } } };
    expect(
      validateRuleInLens({ field: 'settings', operator: 'equals', value: 'b' }, narrowed).ok,
    ).toBe(false);
    expect(
      validateRuleInLens({ field: 'settings.theme', operator: 'equals', value: 'b' }, narrowed).ok,
    ).toBe(true);
  });
});

describe('validateRuleInLens — nested scopes below the Json boundary', () => {
  const jsonArrayRule = (inner: Record<string, unknown>) => ({
    field: 'metadata.items',
    arrayOperator: 'any' as const,
    condition: inner as never,
  });

  test('a nested condition on an undeclared JSON key is accepted', () => {
    expect(
      validateRuleInLens(jsonArrayRule({ field: 'color', operator: 'equals', value: 'red' }), lens)
        .ok,
    ).toBe(true);
  });

  test('an arrayOperator on the bare Json column opens the nested scope too', () => {
    expect(
      validateRuleInLens(
        {
          field: 'metadata',
          arrayOperator: 'any',
          condition: { field: 'color', operator: 'equals', value: 'red' },
        },
        lens,
      ).ok,
    ).toBe(true);
  });

  test('filter, orderBy and aggregate.field below the boundary are open-ended', () => {
    const res = validateRuleInLens(
      {
        field: 'metadata.items',
        arrayOperator: 'any',
        filter: { field: 'color', operator: 'equals', value: 'red' },
        orderBy: [{ field: 'rank', dir: 'asc' }],
        condition: { field: 'color', operator: 'equals', value: 'red' },
      } as never,
      lens,
    );
    expect(res.ok).toBe(true);

    const agg = validateRuleInLens(
      {
        field: 'metadata.items',
        aggregate: { mode: 'sum', field: 'amount' },
        operator: 'greaterThan',
        value: 1,
      } as never,
      lens,
    );
    expect(agg.ok).toBe(true);
  });

  test('a `$.` comparison ref below the boundary is open-ended', () => {
    expect(
      validateRuleInLens(
        jsonArrayRule({ field: 'color', operator: 'equals', path: '$.fallbackColor' }),
        lens,
      ).ok,
    ).toBe(true);
  });

  test('a root-anchored comparison ref is still gated inside an open scope', () => {
    expect(
      validateRuleInLens(
        jsonArrayRule({ field: 'color', operator: 'equals', path: 'firstName' }),
        lens,
      ).ok,
    ).toBe(true);
    expect(
      validateRuleInLens(jsonArrayRule({ field: 'color', operator: 'equals', path: 'nope' }), lens)
        .ok,
    ).toBe(false);
  });

  test('a relation nested scope is still resolved strictly', () => {
    expect(
      validateRuleInLens(
        {
          field: 'posts',
          arrayOperator: 'any',
          condition: { field: 'color', operator: 'equals', value: 'x' },
        },
        lens,
      ).ok,
    ).toBe(false);
  });
});

describe('validateRuleInLens — narrowing governs the Json column, sub-paths follow', () => {
  test('omitting the column rejects its sub-paths', () => {
    const narrowed = { parent: lens, root: { omits: ['metadata'] } };
    expect(validateRuleInLens({ field: 'metadata', operator: 'exists' }, narrowed).ok).toBe(false);
    expect(
      validateRuleInLens({ field: 'metadata.theme', operator: 'equals', value: 'x' }, narrowed).ok,
    ).toBe(false);
  });

  test('picking the column keeps its sub-paths', () => {
    const narrowed = { parent: lens, root: { picks: ['metadata'] } };
    expect(
      validateRuleInLens({ field: 'metadata.theme', operator: 'equals', value: 'x' }, narrowed).ok,
    ).toBe(true);
    expect(validateRuleInLens({ field: 'id', operator: 'equals', value: 'x' }, narrowed).ok).toBe(
      false,
    );
  });
});

describe('describeRule — Json sub-paths', () => {
  test('a Json sub-path is not a violation; a non-Json scalar sub-path is', () => {
    expect(
      describeRule({ field: 'metadata.theme', operator: 'equals', value: 'x' }, lens).violations,
    ).toEqual([]);
    expect(
      describeRule({ field: 'firstName.foo', operator: 'equals', value: 'x' }, lens).violations,
    ).toEqual(['firstName.foo']);
  });

  test('nested conditions below the boundary produce no violations', () => {
    expect(
      describeRule(
        {
          field: 'metadata.items',
          arrayOperator: 'any',
          condition: { field: 'color', operator: 'equals', value: 'x' },
        },
        lens,
      ).violations,
    ).toEqual([]);
  });
});

describe('coerceRule — the kind is undeclared below the Json boundary', () => {
  test('a Json sub-path is left unstamped', () => {
    expect(coerceRule({ field: 'metadata.count', operator: 'equals', value: '5' }, lens)).toEqual({
      field: 'metadata.count',
      operator: 'equals',
      value: '5',
    });
  });

  test('declared scalars are still stamped', () => {
    expect(coerceRule({ field: 'age', operator: 'equals', value: '5' }, lens)).toEqual({
      field: 'age',
      operator: 'equals',
      value: '5',
      coerceType: 'Int',
    });
  });

  test('a nested condition below a Json array boundary is not stamped against declared fields', () => {
    const rule = {
      field: 'metadata.items',
      arrayOperator: 'any' as const,
      condition: { field: 'age', operator: 'equals' as const, value: '5' },
    };
    expect(coerceRule(rule as never, lens)).toEqual(rule as never);
  });
});

describe('narrowRule — Json sub-paths', () => {
  const narrowed = {
    parent: lens,
    root: { where: { field: 'id', operator: 'equals' as const, value: '1' } },
  };

  test('a Json sub-path rule passes through unrewritten under the model where', () => {
    expect(
      narrowRule({ field: 'metadata.theme', operator: 'equals', value: 'dark' }, narrowed),
    ).toEqual({
      all: [
        { field: 'id', operator: 'equals', value: '1' },
        { field: 'metadata.theme', operator: 'equals', value: 'dark' },
      ],
    });
  });

  test('no grant is injected into a nested condition below the boundary', () => {
    const rule = {
      field: 'metadata.items',
      arrayOperator: 'any' as const,
      condition: { field: 'color', operator: 'equals' as const, value: 'red' },
    };
    expect(narrowRule(rule as never, narrowed)).toEqual({
      all: [{ field: 'id', operator: 'equals', value: '1' }, rule],
    } as never);
  });
});

describe('projection — the Json column is the leaf it already is', () => {
  test('projectPaths exposes the column and keys no path below it', () => {
    const proj = projectLens(lens);
    expect(Object.keys(proj)).toEqual(['User']);
    expect(proj.User?.fields.metadata).toEqual({ kind: 'scalar', type: 'Json' });
  });

  test('picks and omits compose on the column itself', () => {
    expect(
      Object.keys(projectLens({ parent: lens, root: { omits: ['metadata'] } }).User?.fields ?? {}),
    ).not.toContain('metadata');
    expect(
      Object.keys(
        projectLens({ parent: lens, root: { picks: ['metadata'] } }, { by: 'model' }).maps.app
          .models.User.fields,
      ),
    ).toEqual(['metadata']);
  });
});

describe('check — below the boundary the value kind is unknown', () => {
  const data = { metadata: { theme: 'dark', a: { b: 1 }, tags: ['x'] } };

  test('generic operators evaluate against the traversed JSON value', () => {
    expect(check({ field: 'metadata.theme', operator: 'equals', value: 'dark' }, data)).toBe(true);
    expect(check({ field: 'metadata.tags', operator: 'contains', value: 'x' }, data)).toBe(true);
    expect(check({ field: 'metadata.nope', operator: 'exists' }, data)).not.toBe(true);
  });

  test('a type mismatch below the boundary fails the comparison rather than throwing', () => {
    expect(check({ field: 'metadata.a', operator: 'lessThan', value: 5 }, data)).toBe(
      'metadata.a must be less than 5',
    );
  });
});
