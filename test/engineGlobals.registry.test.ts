import { afterEach, describe, expect, test } from 'bun:test';
import { engineGlobals, registerEngineGlobals } from '../index';

declare module '../index' {
  interface EngineGlobalValues {
    'testLib.idField': string;
    'testLib.nested.flag': boolean;
    'lateLib.mode': string;
  }
}

registerEngineGlobals('testLib', { idField: 'id', 'nested.flag': false });

afterEach(() => engineGlobals.reset());

describe('registerEngineGlobals', () => {
  test('a registered namespace reads its defaults and takes set like the engine’s own paths', () => {
    expect(engineGlobals.get('testLib.idField')).toBe('id');
    expect(engineGlobals.get('testLib.nested.flag')).toBe(false);
    engineGlobals.set('testLib.idField', 'uuid');
    expect(engineGlobals.get('testLib.idField')).toBe('uuid');
  });

  test('reset restores registered defaults, not just the engine’s', () => {
    engineGlobals.set('testLib.idField', 'uuid');
    engineGlobals.set('sql.dialect', 'mysql');
    engineGlobals.reset();
    expect(engineGlobals.get('testLib.idField')).toBe('id');
    expect(engineGlobals.get('sql.dialect')).toBe('postgres');
  });

  test('a value set before the library registers survives its defaults', () => {
    engineGlobals.set('lateLib.mode', 'strict');
    registerEngineGlobals('lateLib', { mode: 'loose' });
    expect(engineGlobals.get('lateLib.mode')).toBe('strict');
    engineGlobals.reset();
    expect(engineGlobals.get('lateLib.mode')).toBe('loose');
  });

  test('registering the same defaults again is a no-op; other defaults throw', () => {
    expect(() =>
      registerEngineGlobals('testLib', { idField: 'id', 'nested.flag': false }),
    ).not.toThrow();
    expect(() =>
      registerEngineGlobals('testLib', { idField: 'uuid', 'nested.flag': false }),
    ).toThrow(/other defaults/);
  });

  test('a dotted, empty or engine-owned namespace throws', () => {
    expect(() => registerEngineGlobals('a.b' as 'testLib', {} as never)).toThrow(
      /one non-empty segment/,
    );
    expect(() => registerEngineGlobals('' as 'testLib', {} as never)).toThrow(
      /one non-empty segment/,
    );
    expect(() => registerEngineGlobals('sql' as 'testLib', {} as never)).toThrow(
      /belongs to json-rules/,
    );
  });
});

describe('engineGlobals.with', () => {
  test('takes flat paths, scoped to the callback', () => {
    const seen = engineGlobals.with({ 'testLib.idField': 'uuid', 'sql.dialect': 'mysql' }, () => [
      engineGlobals.get('testLib.idField'),
      engineGlobals.get('sql.dialect'),
    ]);
    expect(seen).toEqual(['uuid', 'mysql']);
    expect(engineGlobals.get('testLib.idField')).toBe('id');
    expect(engineGlobals.get('sql.dialect')).toBe('postgres');
  });

  test('still takes the nested shape', () => {
    const seen = engineGlobals.with({ string: { caseInsensitive: true } }, () =>
      engineGlobals.get('string.caseInsensitive'),
    );
    expect(seen).toBe(true);
    expect(engineGlobals.get('string.fuzzy')).toBe(false);
  });
});

describe('one store per process', () => {
  test('the store is reachable from the process-wide holder another copy would find', () => {
    const holder = (globalThis as Record<symbol, { store: Record<string, unknown> }>)[
      Symbol.for('@inixiative/json-rules/engineGlobals@3')
    ];
    engineGlobals.set('testLib.idField', 'uuid');
    expect((holder.store.testLib as { idField: string }).idField).toBe('uuid');
  });
});
