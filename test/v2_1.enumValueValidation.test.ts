import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// checkRuleAgainstLens should validate that enum field values used in rules are
// in the allowed set, considering:
//   1. FieldMap.enums[type] (registry)
//   2. FieldMapEntry.values (per-field override)
//   3. mapDefaults.enums[type] (lens-level enum narrowing)
//   4. ModelNarrowing.enumPicks/enumOmits[fieldName] (per-field-per-visit narrowing)

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
      },
    },
  },
  enums: {
    UserRole: ['admin', 'member', 'owner', 'guest'],
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('checkRuleAgainstLens — enum value validation', () => {
  test('rule value in registry → passes', () => {
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'admin' },
      lens,
    );
    expect(result.ok).toBe(true);
  });

  test('rule value NOT in registry → rejected with helpful violation', () => {
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'GHOST' },
      lens,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('role');
    expect(result.violations[0].reason).toMatch(/enum|value|GHOST/i);
  });

  test('rule value narrowed away by enumPicks → rejected', () => {
    const n = withParent(lens, {
      root: { enumPicks: { role: ['admin', 'member'] } },
    });
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'owner' },
      n,
    );
    expect(result.ok).toBe(false);
  });

  test('rule value narrowed away by enumOmits → rejected', () => {
    const n = withParent(lens, {
      root: { enumOmits: { role: ['owner'] } },
    });
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'owner' },
      n,
    );
    expect(result.ok).toBe(false);
  });

  test('rule value narrowed away by mapDefaults.enums → rejected', () => {
    const n = withParent(lens, {
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'owner' },
      n,
    );
    expect(result.ok).toBe(false);
  });

  test('in/notIn operator: array value with one bad member → rejected', () => {
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.in, value: ['admin', 'GHOST'] },
      lens,
    );
    expect(result.ok).toBe(false);
  });

  test('FieldMapEntry.values takes precedence over registry', () => {
    const mapWithFieldValues: FieldMap = {
      models: {
        User: {
          fields: {
            role: {
              kind: 'enum',
              type: 'UserRole',
              values: ['admin'], // tighter than registry
            },
          },
        },
      },
      enums: { UserRole: ['admin', 'member', 'owner', 'guest'] },
    };
    const lensF: Lens = { maps: { prisma: mapWithFieldValues }, mapName: 'prisma', model: 'User' };
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'member' }, // valid in registry but not in field values
      lensF,
    );
    expect(result.ok).toBe(false);
  });

  test('enum value validation inside `all` (recurses into compound conditions)', () => {
    const result = checkRuleAgainstLens(
      {
        all: [
          { field: 'id', operator: Operator.equals, value: 'u1' },
          { field: 'role', operator: Operator.equals, value: 'GHOST' }, // bad
        ],
      },
      lens,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === 'role')).toBe(true);
  });

  test('enum value validation inside `any`', () => {
    const result = checkRuleAgainstLens(
      {
        any: [
          { field: 'role', operator: Operator.equals, value: 'admin' },
          { field: 'role', operator: Operator.equals, value: 'GHOST' },
        ],
      },
      lens,
    );
    expect(result.ok).toBe(false);
  });

  test('enum value validation inside `if/then/else`', () => {
    const result = checkRuleAgainstLens(
      {
        if: { field: 'id', operator: Operator.equals, value: 'u1' },
        then: { field: 'role', operator: Operator.equals, value: 'GHOST' },
        else: { field: 'role', operator: Operator.equals, value: 'admin' },
      },
      lens,
    );
    expect(result.ok).toBe(false);
  });

  test('enum value validation inside arrayRule.condition (recurses with model context flip)', () => {
    const mapWithRel: FieldMap = {
      models: {
        Org: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            users: { kind: 'object', type: 'User', isList: true },
          },
        },
        User: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            role: { kind: 'enum', type: 'UserRole' },
          },
        },
      },
      enums: { UserRole: ['admin', 'member', 'owner', 'guest'] },
    };
    const lensR: Lens = { maps: { prisma: mapWithRel }, mapName: 'prisma', model: 'Org' };
    const result = checkRuleAgainstLens(
      {
        field: 'users',
        arrayOperator: 'any',
        condition: { field: 'role', operator: Operator.equals, value: 'GHOST' },
        // biome-ignore lint/suspicious/noExplicitAny: terse test rule
      } as any,
      lensR,
    );
    expect(result.ok).toBe(false);
  });

  test('no enum registry and no per-field values → skip validation (value passes through)', () => {
    const bareMap: FieldMap = {
      models: {
        User: {
          fields: { role: { kind: 'enum', type: 'UnknownEnum' } },
        },
      },
      // no enums registry
    };
    const lensB: Lens = { maps: { prisma: bareMap }, mapName: 'prisma', model: 'User' };
    const result = checkRuleAgainstLens(
      { field: 'role', operator: Operator.equals, value: 'anything' },
      lensB,
    );
    expect(result.ok).toBe(true);
  });
});
