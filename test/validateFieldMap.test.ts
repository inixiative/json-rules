import { describe, expect, test } from 'bun:test';
import { validateFieldMap, validateFieldMapSet } from '../src/fieldMap/validate';
import type { FieldMap } from '../src/toPrisma/types';

describe('validateFieldMapSet', () => {
  test('passes for clean set', () => {
    expect(() =>
      validateFieldMapSet({
        prisma: { FanUser: { fields: { id: { kind: 'scalar', type: 'String' } } } },
      }),
    ).not.toThrow();
  });

  test('throws on dot in field name', () => {
    expect(() =>
      validateFieldMapSet({
        prisma: {
          FanUser: { fields: { 'foo.bar': { kind: 'scalar', type: 'String' } } },
        },
      }),
    ).toThrow(/'prisma:FanUser\.foo\.bar' contains forbidden character/);
  });

  test('throws on colon in field name', () => {
    expect(() =>
      validateFieldMapSet({
        prisma: {
          FanUser: { fields: { 'foo:bar': { kind: 'scalar', type: 'String' } } },
        },
      }),
    ).toThrow(/'prisma:FanUser\.foo:bar' contains forbidden character/);
  });

  test('accumulates errors and lists all in single throw', () => {
    let err: Error | undefined;
    try {
      validateFieldMapSet({
        prisma: {
          FanUser: {
            fields: {
              'one.bad': { kind: 'scalar', type: 'String' },
              'two:bad': { kind: 'scalar', type: 'String' },
            },
          },
          Brand: {
            fields: { 'three.bad': { kind: 'scalar', type: 'String' } },
          },
        },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('one.bad');
    expect(err?.message).toContain('two:bad');
    expect(err?.message).toContain('three.bad');
  });
});

describe('validateFieldMap', () => {
  test('passes for clean map', () => {
    const fm: FieldMap = {
      FanUser: { fields: { id: { kind: 'scalar', type: 'String' } } },
    };
    expect(() => validateFieldMap(fm)).not.toThrow();
  });

  test('uses default mapName when omitted', () => {
    const fm: FieldMap = {
      FanUser: { fields: { 'a.b': { kind: 'scalar', type: 'String' } } },
    };
    expect(() => validateFieldMap(fm)).toThrow(/'fieldMap:FanUser/);
  });

  test('uses provided mapName', () => {
    const fm: FieldMap = {
      FanUser: { fields: { 'a.b': { kind: 'scalar', type: 'String' } } },
    };
    expect(() => validateFieldMap(fm, 'prisma')).toThrow(/'prisma:FanUser/);
  });
});
