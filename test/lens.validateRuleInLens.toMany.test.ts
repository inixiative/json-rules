import { describe, expect, test } from 'bun:test';
import { check, readLensValue, toPrisma, validateRuleInLens, walkLensPath } from '../index';
import type { FieldMap } from '../src/fieldMap/types';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { Condition } from '../src/types';

const col = { kind: 'scalar', type: 'String' } as const;
const map: FieldMap = {
  models: {
    Conversation: {
      fields: {
        id: col,
        tags: { kind: 'scalar', type: 'String', isList: true },
        meta: { kind: 'scalar', type: 'Json' },
        orgId: col,
        org: { kind: 'object', type: 'Org', fromFields: ['orgId'], toFields: ['id'] },
        messages: { kind: 'object', type: 'Message', isList: true },
      },
    },
    Message: {
      fields: {
        id: col,
        authorId: col,
        conversationId: col,
        author: { kind: 'object', type: 'User', fromFields: ['authorId'], toFields: ['id'] },
        conversation: {
          kind: 'object',
          type: 'Conversation',
          fromFields: ['conversationId'],
          toFields: ['id'],
        },
      },
    },
    Org: { fields: { id: col, members: { kind: 'object', type: 'User', isList: true } } },
    User: { fields: { id: col, name: col, orgId: col } },
  },
};

const lens: LensNarrowing = {
  parent: { maps: { app: map }, mapName: 'app', model: 'Conversation' } satisfies Lens,
  root: {
    relations: {
      messages: { relations: { author: {}, conversation: { relations: { messages: {} } } } },
      org: { relations: { members: {} } },
    },
  },
};

const row = {
  id: 'c1',
  tags: ['a'],
  meta: { a: { b: 1 } },
  org: { id: 'o1', members: [{ id: 'u1', name: 'Ann' }] },
  messages: [{ id: 'm1', authorId: 'u1', author: { id: 'u1', name: 'Ann' } }],
};

const errors = (rule: Condition) => validateRuleInLens(rule, lens).errors;
const toManyMessage = (field: string, prefix: string) =>
  `'${field}' reads through the to-many relation '${prefix}'; compare its rows with an arrayOperator rule on '${prefix}'.`;
const anyMessage = (condition: Condition): Condition => ({
  field: 'messages',
  arrayOperator: ArrayOperator.any,
  condition,
});

describe('validateRuleInLens — a plain path never continues past a to-many relation', () => {
  test('a field through a to-many relation is refused, with the message toPrisma throws', () => {
    for (const [field, walked, prefix] of [
      ['messages.authorId', 'messages.authorId', 'messages'],
      ['messages.author.name', 'messages.author.name', 'messages'],
      ['["messages"]["authorId"]', '["messages"]["authorId"]', 'messages'],
      ['org.members.name', 'org.members.name', 'org.members'],
    ]) {
      const rule = { field, operator: Operator.equals, value: 'u1' } as Condition;
      expect(errors(rule)).toEqual([
        { path: field, code: 'not_in_lens', message: toManyMessage(walked, prefix) },
      ]);
      expect(() => toPrisma(rule, { lens })).toThrow(toManyMessage(field, prefix));
      expect(readLensValue(lens, row, field)).toEqual({ ok: false, reason: 'list' });
      // The lens walk still resolves the path: only the gate's cardinality refuses it.
      expect(walkLensPath(lens, field).outcome).toBe('resolved');
    }
  });

  test('a value path and a $-scope ref through a to-many relation are refused', () => {
    const valuePath = { field: 'id', operator: Operator.equals, path: 'messages.authorId' };
    expect(errors(valuePath as Condition)).toEqual([
      {
        path: 'messages.authorId',
        code: 'not_in_lens',
        message: toManyMessage('messages.authorId', 'messages'),
      },
    ]);
    const scopedField = anyMessage({
      field: '$$.messages.authorId',
      operator: Operator.equals,
      value: 'u1',
    });
    expect(errors(scopedField)).toEqual([
      {
        path: '$$.messages.authorId',
        code: 'not_in_lens',
        message: toManyMessage('messages.authorId', 'messages'),
      },
    ]);
    const scopedPath = anyMessage({
      field: 'authorId',
      operator: Operator.equals,
      path: '$$.messages.authorId',
    } as Condition);
    expect(errors(scopedPath).map((e) => [e.path, e.message])).toEqual([
      ['$$.messages.authorId', toManyMessage('messages.authorId', 'messages')],
    ]);
  });

  test('an orderBy field through a to-many relation is refused', () => {
    const ordered = {
      field: 'org.members',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'name', direction: 'asc' }],
      take: 1,
      condition: { field: 'name', operator: Operator.exists },
    } as unknown as Condition;
    expect(errors(ordered)).toEqual([]);
    const throughList = {
      field: 'messages',
      arrayOperator: ArrayOperator.any,
      orderBy: [{ field: 'conversation.messages.id', direction: 'asc' }],
      take: 1,
      condition: { field: 'id', operator: Operator.exists },
    } as unknown as Condition;
    expect(errors(throughList).map((e) => [e.path, e.message])).toEqual([
      [
        'conversation.messages.id',
        toManyMessage('conversation.messages.id', 'conversation.messages'),
      ],
    ]);
  });

  test('an arrayOperator reads the to-many rows, and its condition reads their columns', () => {
    const rules: Condition[] = [
      anyMessage({ field: 'authorId', operator: Operator.equals, value: 'u1' }),
      anyMessage({ field: 'author.name', operator: Operator.equals, value: 'Ann' }),
      {
        field: 'org.members',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'name', operator: Operator.equals, value: 'Ann' },
      },
      { field: 'messages', arrayOperator: ArrayOperator.notEmpty },
    ];
    for (const rule of rules) {
      expect(errors(rule)).toEqual([]);
      expect(check(rule, row)).toBe(true);
      expect(() => toPrisma(rule, { lens })).not.toThrow();
    }
  });

  test('a scalar list column and a Json column are unaffected', () => {
    expect(errors({ field: 'tags', operator: Operator.contains, value: 'a' })).toEqual([]);
    expect(errors({ field: 'meta.a.b', operator: Operator.equals, value: 1 })).toEqual([]);
    expect(errors({ field: 'tags.length', operator: Operator.equals, value: 1 })).toEqual([
      {
        path: 'tags.length',
        code: 'not_in_lens',
        message: 'path does not resolve through the narrowed lens',
      },
    ]);
  });
});
