import { describe, expect, test } from 'bun:test';
import { check, pathSegments } from '../index';

// The keys a path reads, as check() reads them, for code that walks a path of its own.

describe('pathSegments', () => {
  test('dotted names, bracket indices and quoted keys', () => {
    expect(pathSegments('a.b.c')).toEqual(['a', 'b', 'c']);
    expect(pathSegments('messages.0.authorId')).toEqual(['messages', '0', 'authorId']);
    expect(pathSegments('messages[0].authorId')).toEqual(['messages', '0', 'authorId']);
    expect(pathSegments('["messages"][0]["authorId"]')).toEqual(['messages', '0', 'authorId']);
    expect(pathSegments("meta['a.b'].c")).toEqual(['meta', 'a.b', 'c']);
    expect(pathSegments('')).toEqual(['']);
  });

  test('check() reads the keys pathSegments names', () => {
    const row = { messages: [{ authorId: 'u1' }], meta: { 'a.b': { c: 1 } } };
    for (const field of [
      'messages.0.authorId',
      'messages[0].authorId',
      '["messages"][0]["authorId"]',
    ])
      expect(pathSegments(field)).toEqual(['messages', '0', 'authorId']);
    expect(
      check({ field: '["messages"][0]["authorId"]', operator: 'equals', value: 'u1' }, row),
    ).toBe(true);
    expect(check({ field: "meta['a.b'].c", operator: 'equals', value: 1 }, row)).toBe(true);
  });
});
