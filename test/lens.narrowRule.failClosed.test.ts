import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap, Lens, LensNarrowing } from '../index';
import { narrowRule } from '../index';
import { prefixConditionFields } from '../src/lens/narrowRule';

// Where a grant cannot be placed soundly, narrowRule throws rather than emit a rule the grant
// doesn't constrain.

const map: FieldMap = {
  models: {
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        authorId: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', fromFields: ['authorId'], toFields: ['id'] },
        comments: { kind: 'object', type: 'Comment', isList: true },
      },
    },
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tenantId: { kind: 'scalar', type: 'String' },
      },
    },
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        body: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};
const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'Post' };
const rule = (r: object): Condition => r as never;

describe('narrowRule fails closed', () => {
  test('a to-many grant reached by a dotted path, not an array operator', () => {
    const scoped: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        app: { models: { Comment: { where: rule({ field: 'deletedAt', operator: 'isEmpty' }) } } },
      },
    };
    expect(() =>
      narrowRule(rule({ field: 'comments.body', operator: 'equals', value: 'x' }), scoped),
    ).toThrow("cannot enforce a to-many relation grant on 'comments'");
  });

  test('a grant that cannot be re-rooted under its hop', () => {
    expect(() =>
      prefixConditionFields(rule({ field: 'id', operator: 'equals', path: 'me' }), 'author'),
    ).toThrow('path reference');
    expect(() =>
      prefixConditionFields(rule({ field: '$.id', operator: 'exists' }), 'author'),
    ).toThrow('scope ref field');
    expect(() =>
      prefixConditionFields(
        rule({
          field: 'tags',
          arrayOperator: 'any',
          condition: { field: 'x', operator: 'equals', path: '$$.y' },
        }),
        'author',
      ),
    ).toThrow('reads the row being re-rooted');
    expect(() => prefixConditionFields(rule({ operator: 'exists' }), 'author')).toThrow(
      'unknown shape',
    );
  });

  test('a relation node re-roots by its field: its condition reads its elements', () => {
    expect(
      prefixConditionFields(
        rule({
          field: 'tags',
          arrayOperator: 'any',
          condition: { field: 'x', operator: 'exists' },
        }),
        'author',
      ),
    ).toEqual({
      field: 'author.tags',
      arrayOperator: 'any',
      condition: { field: 'x', operator: 'exists' },
    });
  });

  test('a re-rootable grant is prefixed through logical nodes', () => {
    expect(
      prefixConditionFields(
        rule({ any: [{ field: 'tenantId', operator: 'equals', value: 't' }, true] }),
        'author',
      ),
    ).toEqual(rule({ any: [{ field: 'author.tenantId', operator: 'equals', value: 't' }, true] }));
  });
});
