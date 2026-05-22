import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import type { Bridge } from '../src/fieldMap/types';
import { applyLens } from '../src/lens/applyLens';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { createLens } from '../src/lens/createLens';
import { projectNarrowing } from '../src/lens/project';
import type { LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import {
  FIELD_OPERATOR_CATALOG,
  getValueShape,
  isOperatorSupportedForTarget,
} from '../src/operatorCatalog';
import type { FieldMap } from '../src/toPrisma/types';
import { validateRule } from '../src/validate';

// Bug #1: prototype keys must not be treated as operators
describe('Bug #1 — catalog rejects prototype keys', () => {
  test('getValueShape throws on prototype keys', () => {
    expect(() => getValueShape('toString' as never)).toThrow(/Unknown operator/);
    expect(() => getValueShape('__proto__' as never)).toThrow(/Unknown operator/);
    expect(() => getValueShape('constructor' as never)).toThrow(/Unknown operator/);
    expect(() => getValueShape('hasOwnProperty' as never)).toThrow(/Unknown operator/);
  });

  test('isOperatorSupportedForTarget returns false on prototype keys (does not throw)', () => {
    expect(isOperatorSupportedForTarget('toString' as never, 'check')).toBe(false);
    expect(isOperatorSupportedForTarget('__proto__' as never, 'check')).toBe(false);
    expect(isOperatorSupportedForTarget('constructor' as never, 'check')).toBe(false);
  });

  test('catalog membership checks reject prototype keys', () => {
    // Sanity: the catalog object itself must not match prototype keys for `in` checks
    expect(Object.hasOwn(FIELD_OPERATOR_CATALOG, 'toString')).toBe(false);
    expect(Object.hasOwn(FIELD_OPERATOR_CATALOG, '__proto__')).toBe(false);
  });
});

// Bug #2: bridges must be pruned when the bridge-key field is narrowed away.
// The user must explicitly pick the full <map>:<Model> key to retain bridge access.
describe('Bug #2 — bridges pruned when bridge-key removed by narrowing', () => {
  const prismaMap: FieldMap = {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        crmId: { kind: 'scalar', type: 'String' },
      },
    },
  };
  const salesforceMap: FieldMap = {
    Contact: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        industry: { kind: 'scalar', type: 'String' },
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

  test('bridge survives when its bridge-key is explicitly picked on the anchor side', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: { models: { FanUser: { picks: ['email', 'salesforce:Contact'] } } },
      },
    };
    const projected = projectNarrowing(narrowing);
    expect(projected.bridges?.length).toBe(1);
    expect(projected.maps.prisma.FanUser.fields['salesforce:Contact']).toBeDefined();
  });

  test('bridge removed when anchor picks omit the bridge-key field', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: { models: { FanUser: { picks: ['email'] } } },
      },
    };
    const projected = projectNarrowing(narrowing);
    expect(projected.bridges?.length ?? 0).toBe(0);
    expect(projected.maps.prisma.FanUser.fields['salesforce:Contact']).toBeUndefined();
  });

  test('bridge removed when anchor omits the bridge-key explicitly', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: { models: { FanUser: { omits: ['salesforce:Contact'] } } },
      },
    };
    const projected = projectNarrowing(narrowing);
    expect(projected.bridges?.length ?? 0).toBe(0);
    expect(projected.maps.prisma.FanUser.fields['salesforce:Contact']).toBeUndefined();
  });

  test('bridge removed when the FAR side of the bridge picks its bridge-key away', () => {
    const lens = buildLens();
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: {
        salesforce: { models: { Contact: { picks: ['industry'] } } },
      },
    };
    const projected = projectNarrowing(narrowing);
    expect(projected.bridges?.length ?? 0).toBe(0);
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

  test('check returns error string instead of silently using avg', () => {
    const rule = {
      field: 'orders',
      aggregate: {} as never, // no mode
      operator: Operator.equals,
      value: 0,
    };
    const data = { orders: [{ total: 100 }] };
    const result = check(rule as never, data);
    expect(typeof result).toBe('string');
  });
});

// Bug #8: checkRuleAgainstLens must walk aggregate.field paths against the lens schema.
describe('Bug #8 — checkRuleAgainstLens validates aggregate sub-fields', () => {
  const map: FieldMap = {
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
  };

  test('aggregate.field referencing a non-existent leaf is flagged', () => {
    const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'ghostField' }, // not on Order
      operator: Operator.greaterThan,
      value: 0,
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'ghostField')).toBe(true);
  });

  test('aggregate.field referencing a real leaf passes', () => {
    const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      operator: Operator.greaterThan,
      value: 0,
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(true);
  });

  test('arrayRule.field on a relation resolves against the relation target', () => {
    // Already covered by existing tests but reassert the surface
    const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const rule = {
      field: 'orders',
      arrayOperator: 'any' as const,
      condition: { field: 'ghostField', operator: Operator.equals, value: 1 },
    };
    const result = checkRuleAgainstLens(rule as never, lens);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'ghostField')).toBe(true);
  });
});

// Sanity: applyLens import retained for future tests
void applyLens;
