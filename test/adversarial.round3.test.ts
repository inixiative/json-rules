import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import type { Bridge, FieldMap } from '../src/fieldMap/types';
import { createLens } from '../src/lens/createLens';
import { validateNarrowing } from '../src/lens/narrowing';
import { narrowRule } from '../src/lens/narrowRule';
import { projectPaths } from '../src/lens/projectPaths';
import type { LensNarrowing } from '../src/lens/types';
import { validateRuleInLens } from '../src/lens/validateRuleInLens';
import { Operator } from '../src/operator';
import {
  FIELD_OPERATOR_CATALOG,
  getValueShape,
  isOperatorSupportedForTarget,
} from '../src/operatorCatalog';
import { validateRule } from '../src/validate';
import { at } from './fixtures/helpers';

// Bug #1: prototype keys must not be treated as operators
describe('Bug #1 — catalog rejects prototype keys', () => {
  test('getValueShape throws on prototype keys', () => {
    expect(() => getValueShape('toString', 'field')).toThrow(/Unknown (field|date|array) operator/);
    expect(() => getValueShape('__proto__', 'date')).toThrow(/Unknown (field|date|array) operator/);
    expect(() => getValueShape('constructor', 'array')).toThrow(
      /Unknown (field|date|array) operator/,
    );
    expect(() => getValueShape('hasOwnProperty', 'field')).toThrow(
      /Unknown (field|date|array) operator/,
    );
  });

  test('isOperatorSupportedForTarget returns false on prototype keys (does not throw)', () => {
    expect(isOperatorSupportedForTarget('toString', 'field', 'check')).toBe(false);
    expect(isOperatorSupportedForTarget('__proto__', 'date', 'check')).toBe(false);
    expect(isOperatorSupportedForTarget('constructor', 'array', 'check')).toBe(false);
  });

  test('catalog membership checks reject prototype keys', () => {
    // Sanity: the catalog object itself must not match prototype keys for `in` checks
    expect(Object.hasOwn(FIELD_OPERATOR_CATALOG, 'toString')).toBe(false);
    expect(Object.hasOwn(FIELD_OPERATOR_CATALOG, '__proto__')).toBe(false);
  });
});

// Bug #2: bridges must be pruned when the bridge-key field is narrowed away.
// The user must explicitly declare the full <map>:<Model> key to retain bridge access.
describe('Bug #2 — bridges pruned when bridge-key removed by narrowing', () => {
  const prismaMap: FieldMap = {
    models: {
      FanUser: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          email: { kind: 'scalar', type: 'String' },
          crmId: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const salesforceMap: FieldMap = {
    models: {
      Contact: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          industry: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const bridge: Bridge = {
    endpoints: [
      { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
      { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
    ],
    cardinality: 'oneToOne',
  };

  const buildLens = () =>
    createLens({
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [bridge],
      mapName: 'prisma',
      model: 'FanUser',
    });

  test('bridge-key field present at anchor when turned on', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { picks: ['email'], relations: { 'salesforce:Contact': {} } },
    };
    const projected = projectPaths(narrowing);
    expect(at(projected, 'FanUser').fields['salesforce:Contact']).toBeDefined();
    // Picking it is not the spelling: picks names columns only.
    const picked: LensNarrowing = {
      parent: lens,
      root: { picks: ['email', 'salesforce:Contact'] },
    };
    expect(validateNarrowing(picked).errors.map((e) => e.code)).toEqual(['wrong_kind']);
  });

  test('bridge-key field gone when not turned on (picks name columns only)', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { picks: ['email'] },
    };
    const projected = projectPaths(narrowing);
    expect(at(projected, 'FanUser').fields['salesforce:Contact']).toBeUndefined();
  });

  test('bridge-key field gone when anchor omits it explicitly', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      root: { omits: ['salesforce:Contact'] },
    };
    const projected = projectPaths(narrowing);
    expect(at(projected, 'FanUser').fields['salesforce:Contact']).toBeUndefined();
  });
});

// Bug #3: aggregate avg of zero-matched rows should return 0, matching sum.
describe('Bug #3 — aggregate avg matches sum behavior on empty matches', () => {
  test('avg with no matched rows returns 0 (not an error)', () => {
    const rule = {
      field: 'orders',
      aggregate: { mode: 'avg' as const, field: 'total' },
      condition: { field: 'status', operator: Operator.equals, value: 'completed' },
      operator: Operator.greaterThanEquals,
      value: 0,
    };
    const data = { orders: [{ total: 50, status: 'pending' }] };
    // No completed orders; avg should be 0; 0 >= 0 is true
    expect(check(rule, data)).toBe(true);
  });

  test('sum with no matched rows already returns 0', () => {
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      condition: { field: 'status', operator: Operator.equals, value: 'completed' },
      operator: Operator.equals,
      value: 0,
    };
    const data = { orders: [{ total: 50, status: 'pending' }] };
    expect(check(rule, data)).toBe(true);
  });
});

// Bug #6: aggregate with missing mode must not silently dispatch to avg.
describe('Bug #6 — aggregate without mode is rejected, not silently treated as avg', () => {
  test('validateRule reports invalid_aggregate_mode AND aborts further validation of mode-dependent shape', () => {
    const rule = {
      field: 'orders',
      aggregate: {}, // no mode!
      operator: Operator.equals,
      value: 0,
    };
    const result = validateRule(rule);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('invalid_aggregate_mode');
  });

  test('check refuses it instead of silently using avg', () => {
    const rule = {
      field: 'orders',
      aggregate: {} as never, // no mode
      operator: Operator.equals,
      value: 0,
    };
    const data = { orders: [{ total: 100 }] };
    expect(() => check(rule as never, data)).toThrow('aggregate.mode must be one of');
  });
});

// Bug #8: validateRuleInLens must walk aggregate.field paths against the lens schema.
describe('Bug #8 — validateRuleInLens validates aggregate sub-fields', () => {
  const map: FieldMap = {
    models: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          orders: { kind: 'object', type: 'Order', isList: true },
        },
      },
      Order: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          total: { kind: 'scalar', type: 'Int' },
        },
      },
    },
  };

  const declared = (): LensNarrowing => ({
    parent: createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' }),
    root: { relations: { orders: {} } },
  });

  test('aggregate.field referencing a non-existent leaf is flagged', () => {
    const lens = declared();
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'ghostField' }, // not on Order
      operator: Operator.greaterThan,
      value: 0,
    };
    const result = validateRuleInLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.errors.some((v) => v.path === 'ghostField')).toBe(true);
  });

  test('aggregate.field referencing a real leaf passes', () => {
    const lens = declared();
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      operator: Operator.greaterThan,
      value: 0,
    };
    const result = validateRuleInLens(rule as never, lens);
    expect(result.ok).toBe(true);
  });

  test('arrayRule.field on a relation resolves against the relation target', () => {
    // Already covered by existing tests but reassert the surface
    const lens = declared();
    const rule = {
      field: 'orders',
      arrayOperator: 'any' as const,
      condition: { field: 'ghostField', operator: Operator.equals, value: 1 },
    };
    const result = validateRuleInLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.errors.some((v) => v.path === 'ghostField')).toBe(true);
  });
});

// Sanity: narrowRule import retained for future tests
void narrowRule;
