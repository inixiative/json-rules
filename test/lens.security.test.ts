import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap, Lens, LensNarrowing } from '../index';
import {
  check,
  materializeSources,
  narrowRule,
  projectLens,
  toPrisma,
  toSourceQueries,
  toSql,
  validateRuleInLens,
} from '../index';

// What the lens hides stays hidden — through a child layer's own conditions, value-side refs,
// window and aggregate fields, Json-array scopes, and option lists.

const map: FieldMap = {
  models: {
    Article: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        score: { kind: 'scalar', type: 'Int' },
        meta: { kind: 'scalar', type: 'Json' },
        authorId: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', fromFields: ['authorId'], toFields: ['id'] },
        comments: {
          kind: 'object',
          type: 'Comment',
          isList: true,
          relationName: 'ArticleComments',
        },
      },
    },
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tenantId: { kind: 'scalar', type: 'String' },
        salary: { kind: 'scalar', type: 'Int' },
      },
    },
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        body: { kind: 'scalar', type: 'String' },
        votes: { kind: 'scalar', type: 'Int' },
        deleted: { kind: 'scalar', type: 'Boolean' },
        articleId: { kind: 'scalar', type: 'String' },
        article: {
          kind: 'object',
          type: 'Article',
          fromFields: ['articleId'],
          toFields: ['id'],
          relationName: 'ArticleComments',
        },
        authorId: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', fromFields: ['authorId'], toFields: ['id'] },
      },
    },
  },
};
const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'Article' };
const rule = (r: object): Condition => r as never;
const granted: LensNarrowing = {
  parent: lens,
  mapDefaults: {
    app: {
      models: {
        User: { where: rule({ field: 'tenantId', operator: 'equals', value: 't1' }) },
        Comment: { where: rule({ field: 'deleted', operator: 'equals', value: false }) },
      },
    },
  },
};

describe("a child layer's own conditions read through its parent's grants", () => {
  const probe = rule({
    field: 'comments',
    arrayOperator: 'any',
    condition: { field: 'body', operator: 'equals', value: 'secret' },
  });
  const child: LensNarrowing = {
    parent: granted,
    root: { where: probe, sources: { title: probe } },
  };
  const row = { id: 'a', title: 't', comments: [{ body: 'secret', deleted: true }] };

  test('a child where cannot see a deleted comment the parent hides', () => {
    expect(check(narrowRule(probe, granted), row)).not.toBe(true);
    expect(check(narrowRule(true, child), row)).not.toBe(true);
  });

  test('a child source where carries the parent grant into its query', () => {
    const [query] = toSourceQueries(child);
    expect(JSON.stringify(query.composedWhere)).toContain('"deleted"');
  });
});

describe('refs that cross a relation carry its grant', () => {
  // The author is outside the tenant grant; its salary must not be readable through any slot.
  const row = {
    id: 'a1',
    score: 100,
    meta: { tags: [{ k: 1 }] },
    author: { tenantId: 't2', salary: 100 },
    comments: [
      { body: 'hi', votes: 1, deleted: false, author: { tenantId: 't2', salary: 999 } },
      { body: 'secret', votes: 50, deleted: true, author: { tenantId: 't1', salary: 1 } },
    ],
  };
  const leaks = (r: object) => check(narrowRule(rule(r), granted), row) === true;

  test.each([
    ['a $. value path', { field: 'score', operator: 'equals', path: '$.author.salary' }],
    [
      'a bare value path (the row is the context)',
      { field: 'score', operator: 'equals', path: 'author.salary' },
    ],
    [
      'an offset path',
      { field: 'score', operator: 'equals', value: 0, offset: { path: '$.author.salary' } },
    ],
    [
      'a $$. ref inside a Json-array condition',
      {
        field: 'meta.tags',
        arrayOperator: 'any',
        condition: { field: '$$.author.salary', operator: 'equals', value: 100 },
      },
    ],
    [
      'a $$. value path inside a relation condition',
      {
        field: 'comments',
        arrayOperator: 'any',
        condition: { field: 'votes', operator: 'lessThan', path: '$$.author.salary' },
      },
    ],
  ])('%s', (_, r) => {
    expect(leaks(r)).toBe(false);
  });

  test('an aggregate field through a relation sums only granted rows', () => {
    expect(
      leaks({
        field: 'comments',
        aggregate: { mode: 'sum', field: 'author.salary' },
        operator: 'equals',
        value: 999,
      }),
    ).toBe(false);
  });

  test('an orderBy through a relation orders only granted rows', () => {
    const orderedRow = {
      comments: [
        { body: 'top', deleted: false, author: { tenantId: 't2', salary: 999 } },
        { body: 'kept', deleted: false, author: { tenantId: 't1', salary: 5 } },
      ],
    };
    const r = rule({
      field: 'comments',
      arrayOperator: 'all',
      orderBy: [{ field: 'author.salary', dir: 'desc' }],
      take: 1,
      condition: { field: 'body', operator: 'equals', value: 'top' },
    });
    expect(check(r, orderedRow)).toBe(true);
    expect(check(narrowRule(r, granted), orderedRow)).not.toBe(true);
  });
});

describe('option lists never offer what the lens hides', () => {
  const people: FieldMap = {
    enums: { Status: ['OPEN', 'SECRET'] },
    models: {
      Person: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
          ssn: { kind: 'scalar', type: 'String' },
          status: { kind: 'enum', type: 'Status' },
          team: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const base: Lens = { maps: { app: people }, mapName: 'app', model: 'Person' };
  const rows = [
    { id: '1', name: 'a', ssn: '111-22-3333', status: 'SECRET', team: 'x' },
    { id: '2', name: 'b', ssn: '999', status: 'OPEN', team: 'y' },
  ];

  test('an omitted enum value is not an option, fetched or projected', () => {
    const n: LensNarrowing = {
      parent: base,
      root: { enumOmits: { status: ['SECRET'] }, sources: { status: true } },
    };
    const values = materializeSources(n, rows);
    expect(values[0].options.map((o) => o.value)).toEqual(['OPEN']);
    expect(JSON.stringify(toSourceQueries(n)[0].composedWhere)).toContain('"in"');
    const leaked = [{ ...values[0], options: [{ value: 'OPEN' }, { value: 'SECRET' }] }];
    expect(projectLens(n, { sourceValues: leaked }).Person.fields.status.options).toEqual([
      { value: 'OPEN' },
    ]);
  });

  test("a child that hides the parent source's label and axis drops them", () => {
    const parent: LensNarrowing = {
      parent: base,
      root: { sources: { name: { where: true, label: 'ssn', groupBy: 'team' } } },
    };
    const child: LensNarrowing = { parent, root: { omits: ['ssn', 'team'] } };
    expect(projectLens(parent).Person.sourceLabels).toEqual({ name: 'ssn' });
    expect(projectLens(child).Person.sourceLabels).toEqual({});
    expect(projectLens(child).Person.sourceGroupBys).toEqual({});
    expect(JSON.stringify(materializeSources(child, rows))).not.toContain('111-22-3333');
  });
});

describe('the gate refuses a node that is both logical and a leaf', () => {
  test('if + field', () => {
    const r = rule({ if: true, then: true, field: 'author.salary', operator: 'equals', value: 1 });
    expect(validateRuleInLens(r, granted).errors.map((e) => e.code)).toContain(
      'ambiguous_condition',
    );
  });
});

describe('a relation is never read as a value', () => {
  const hidden: LensNarrowing = {
    parent: lens,
    root: { omits: ['authorId'], relations: { author: { omits: ['salary'] } } },
  };
  const rejects = (r: object) => expect(validateRuleInLens(rule(r), hidden).ok).toBe(false);

  test('a value ref ending on a relation is rejected', () => {
    rejects({ field: 'title', operator: 'equals', path: '$.author' });
    rejects({ field: 'title', operator: 'equals', path: '$.comments' });
    rejects({
      field: 'score',
      operator: 'greaterThan',
      value: 1,
      offset: { path: '$.author' },
    });
  });

  test('a to-many relation takes an array operator, never a value', () => {
    const hiddenChild: LensNarrowing = {
      parent: lens,
      root: { relations: { comments: { omits: ['votes'] } } },
    };
    const asValue = { field: 'comments', operator: 'contains', value: { id: 'c1', votes: 7 } };
    expect(validateRuleInLens(rule(asValue), hiddenChild).errors[0].code).toBe(
      'operator_kind_mismatch',
    );
    expect(
      validateRuleInLens(rule({ field: 'comments', operator: 'exists' }), hiddenChild).ok,
    ).toBe(false);
    const opts = { map, model: 'Article' };
    expect(() => toSql(rule(asValue), opts)).toThrow('is a list of rows');
    expect(() => toPrisma(rule(asValue), opts)).toThrow('is a list of rows');
  });

  test('a relation as a field only exists or not', () => {
    rejects({ field: 'author', operator: 'greaterThan', value: 'm' });
    rejects({ field: 'author', operator: 'between', value: ['a', 'z'] });
    rejects({ field: 'author', operator: 'equals', value: 'u1' });
    expect(validateRuleInLens(rule({ field: 'author', operator: 'exists' }), hidden).ok).toBe(true);
  });

  test('toSql refuses to compare a relation key', () => {
    const opts = { map, model: 'Article' };
    expect(() =>
      toSql(rule({ field: 'author', operator: 'greaterThan', value: 'm' }), opts),
    ).toThrow('is a relation');
    expect(() =>
      toSql(rule({ field: 'title', operator: 'equals', path: '$.author' }), opts),
    ).toThrow('is a relation');
  });
});

describe("an option list on a relation reads only the rows under its ancestors' grants", () => {
  const platform: LensNarrowing = {
    parent: lens,
    root: { where: rule({ field: 'score', operator: 'greaterThan', value: 5 }) },
  };
  const delegate: LensNarrowing = {
    parent: platform,
    root: {
      relations: {
        comments: { sources: { body: true } },
        author: { sources: { tenantId: true } },
      },
    },
  };
  const queries = toSourceQueries(delegate);
  const at = (model: string) => {
    const query = queries.find((q) => q.model === model);
    if (!query) throw new Error(`no source query on ${model}`);
    return query;
  };

  test('a grant carries down through the inverse relation', () => {
    const comments = at('Comment');
    const grant = { field: 'article.score', operator: 'greaterThan', value: 5 };
    expect(JSON.stringify(comments.composedWhere)).toContain(JSON.stringify(grant));
    expect(check(comments.composedWhere, { article: { score: 3 } })).not.toBe(true);
    expect(check(comments.composedWhere, { article: { score: 9 } })).toBe(true);
    expect(check(comments.composedWhere, {})).not.toBe(true);
    expect(comments.sql.sql).toContain('JOIN "Article"');
  });

  test('a grant no inverse can carry offers nothing', () => {
    expect(check(at('User').composedWhere, { tenantId: 't1' })).not.toBe(true);
  });
});
