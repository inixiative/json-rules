import { describe, expect, test } from 'bun:test';
import { assertValidFieldMaps } from '../src/fieldMap/validate';
import type { FieldMap } from '../src/toPrisma/types';

describe('validateFieldMaps', () => {
  test('passes for clean set', () => {
    expect(() =>
      assertValidFieldMaps({
        maps: {
          prisma: { models: { FanUser: { fields: { id: { kind: 'scalar', type: 'String' } } } } },
        },
      }),
    ).not.toThrow();
  });

  test('throws on dot in field name', () => {
    expect(() =>
      assertValidFieldMaps({
        maps: {
          prisma: {
            models: {
              FanUser: { fields: { 'foo.bar': { kind: 'scalar', type: 'String' } } },
            },
          },
        },
      }),
    ).toThrow(/prisma:FanUser\.foo\.bar: contains forbidden character/);
  });

  test('throws on colon in field name', () => {
    expect(() =>
      assertValidFieldMaps({
        maps: {
          prisma: {
            models: {
              FanUser: { fields: { 'foo:bar': { kind: 'scalar', type: 'String' } } },
            },
          },
        },
      }),
    ).toThrow(/prisma:FanUser\.foo:bar: contains forbidden character/);
  });

  test('accumulates errors and lists all in single throw', () => {
    let err: Error | undefined;
    try {
      assertValidFieldMaps({
        maps: {
          prisma: {
            models: {
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

describe('validateFieldMaps — stitched bridges', () => {
  test('accepts bridge entries with colon in name (stitched output)', () => {
    expect(() =>
      assertValidFieldMaps({
        maps: {
          prisma: {
            models: {
              FanUser: {
                fields: {
                  id: { kind: 'scalar', type: 'String' },
                  'salesforce:Contact': {
                    kind: 'bridge',
                    type: 'salesforce:Contact',
                    isList: false,
                  },
                },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test('still rejects colons on non-bridge field entries', () => {
    expect(() =>
      assertValidFieldMaps({
        maps: {
          prisma: {
            models: {
              FanUser: {
                fields: {
                  'foo:bar': { kind: 'scalar', type: 'String' },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/contains forbidden character/);
  });
});

describe('assertValidFieldMaps — a single map', () => {
  test('passes for clean map', () => {
    const fm: FieldMap = {
      models: {
        FanUser: { fields: { id: { kind: 'scalar', type: 'String' } } },
      },
    };
    expect(() => assertValidFieldMaps({ maps: { fieldMap: fm } })).not.toThrow();
  });

  test('names the map in each issue', () => {
    const fm: FieldMap = {
      models: {
        FanUser: { fields: { 'a.b': { kind: 'scalar', type: 'String' } } },
      },
    };
    expect(() => assertValidFieldMaps({ maps: { fieldMap: fm } })).toThrow(/fieldMap:FanUser/);
  });
});
