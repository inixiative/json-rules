import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap, Lens, LensNarrowing } from '../index';
import { check, narrowRule, toSourceQueries } from '../index';

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
        comments: { kind: 'object', type: 'Comment', isList: true },
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
        article: { kind: 'object', type: 'Article', fromFields: ['articleId'], toFields: ['id'] },
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
