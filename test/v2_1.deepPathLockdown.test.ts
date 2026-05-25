import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Lockdown: checkRuleAgainstLens must reject rules whose path goes through
// a relation that the narrowing strips. The library's contract is
// "describe-and-validate" — the narrowing IS the security boundary at
// validation time. (toPrisma/check still execute against the base lens —
// they're not the boundary; checkRuleAgainstLens is.)

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        orgUsers: { kind: 'object', type: 'OrgUser', isList: true },
      },
    },
    OrgUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        role: { kind: 'scalar', type: 'String' },
        organization: { kind: 'object', type: 'Organization', isList: false },
      },
    },
    Organization: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        plan: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('checkRuleAgainstLens — deep-path rejection through un-narrowed relations', () => {
  test('unrestricted lens: deep path passes', () => {
    const result = checkRuleAgainstLens(
      { field: 'orgUsers.organization.name', operator: Operator.equals, value: 'Acme' },
      lens,
    );
    expect(result.ok).toBe(true);
  });

  test('narrowing strips intermediate relation → deep path rejected', () => {
    // OrgUser narrowed to picks=['role'] strips `organization` relation.
    // Deep path orgUsers.organization.name should be rejected.
    const n = withParent(lens, {
      root: {
        relations: {
          orgUsers: { picks: ['role'] }, // organization is now invisible
        },
      },
    });
    const result = checkRuleAgainstLens(
      { field: 'orgUsers.organization.name', operator: Operator.equals, value: 'Acme' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('orgUsers.organization.name');
  });

  test('narrowing strips terminal field → terminal path rejected', () => {
    const n = withParent(lens, {
      root: {
        relations: {
          orgUsers: {
            relations: { organization: { picks: ['id'] } }, // name is invisible
          },
        },
      },
    });
    const result = checkRuleAgainstLens(
      { field: 'orgUsers.organization.name', operator: Operator.equals, value: 'Acme' },
      n,
    );
    expect(result.ok).toBe(false);
  });

  test('partial narrowing: declared path passes, sibling rejected', () => {
    const n = withParent(lens, {
      root: {
        relations: {
          orgUsers: {
            relations: { organization: { picks: ['name'] } },
          },
        },
      },
    });
    // name is declared → passes
    expect(
      checkRuleAgainstLens(
        { field: 'orgUsers.organization.name', operator: Operator.equals, value: 'x' },
        n,
      ).ok,
    ).toBe(true);
    // plan is not declared → rejected
    expect(
      checkRuleAgainstLens(
        { field: 'orgUsers.organization.plan', operator: Operator.equals, value: 'x' },
        n,
      ).ok,
    ).toBe(false);
  });

  test('mapDefaults.models[M].omits also rejects rule paths through omitted field', () => {
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Organization: { omits: ['plan'] } } } },
    });
    const result = checkRuleAgainstLens(
      { field: 'orgUsers.organization.plan', operator: Operator.equals, value: 'enterprise' },
      n,
    );
    expect(result.ok).toBe(false);
  });
});
