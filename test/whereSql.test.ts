import { describe, expect, it } from 'bun:test';
import type { Condition, FieldMapSet, Lens, LensNarrowing } from '../index';
import { DateOperator, Operator, toLensWhereSql, toWhereSql } from '../index';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      BrandReferenceRequest: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          status: { kind: 'scalar', type: 'String' },
          createdAt: { kind: 'scalar', type: 'DateTime' },
          meta: { kind: 'scalar', type: 'Json' },
          tags: { kind: 'scalar', type: 'String', isList: true },
          brandReferenceRequestFanUsers: {
            kind: 'object',
            type: 'BrandReferenceRequestFanUser',
            isList: true,
            relationName: 'RequestFanUsers',
            fromFields: [],
            toFields: [],
          },
        },
      },
      BrandReferenceRequestFanUser: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          affiliation: { kind: 'enum', type: 'Affiliation' },
          requestId: { kind: 'scalar', type: 'Int' },
          request: {
            kind: 'object',
            type: 'BrandReferenceRequest',
            relationName: 'RequestFanUsers',
            fromFields: ['requestId'],
            toFields: ['id'],
          },
        },
      },
    },
    enums: { Affiliation: ['advocate', 'prospect', 'consultant'] },
  },
};

const lens: Lens = { maps, mapName: 'app', model: 'BrandReferenceRequest' };
const set = { map: { maps }, mapName: 'app' };
const affiliation = '${brand_reference_request_fan_user.affiliation}';

const mysql = (condition: Condition, columns: Record<string, string> = { field: 'c' }) =>
  toWhereSql(condition, { columns, dialect: 'mysql' });

describe('toWhereSql — MySQL forms', () => {
  it('writes equals against the caller column, value inline, no joins', () => {
    expect(
      toWhereSql(
        { field: 'affiliation', operator: Operator.equals, value: 'advocate' },
        {
          columns: { affiliation },
          dialect: 'mysql',
          ...set,
          model: 'BrandReferenceRequestFanUser',
        },
      ),
    ).toBe(`${affiliation} = 'advocate'`);
  });

  it('writes in as IN (…) and keeps NULL rows on negations', () => {
    expect(mysql({ field: 'field', operator: Operator.in, value: ['a', 'b'] })).toBe(
      "c IN ('a', 'b')",
    );
    expect(mysql({ field: 'field', operator: Operator.notIn, value: ['a', 'b'] })).toBe(
      "(c NOT IN ('a', 'b') OR c IS NULL)",
    );
    expect(mysql({ field: 'field', operator: Operator.notEquals, value: 'a' })).toBe(
      "(c <> 'a' OR c IS NULL)",
    );
  });

  it('reads a null member and an empty list as check() does', () => {
    expect(mysql({ field: 'field', operator: Operator.in, value: ['a', null] })).toBe(
      "(c IN ('a') OR c IS NULL)",
    );
    expect(mysql({ field: 'field', operator: Operator.notIn, value: ['a', null] })).toBe(
      "(c NOT IN ('a') AND c IS NOT NULL)",
    );
    expect(mysql({ field: 'field', operator: Operator.in, value: [] })).toBe('FALSE');
    expect(mysql({ field: 'field', operator: Operator.notIn, value: [] })).toBe('TRUE');
    expect(mysql({ field: 'field', operator: Operator.equals, value: null })).toBe('c IS NULL');
    expect(mysql({ field: 'field', operator: Operator.notEquals, value: null })).toBe(
      'c IS NOT NULL',
    );
  });

  it('writes numbers and booleans as literals', () => {
    expect(mysql({ field: 'field', operator: Operator.in, value: [1, 2.5] })).toBe('c IN (1, 2.5)');
    expect(mysql({ field: 'field', operator: Operator.equals, value: true })).toBe('c = TRUE');
  });

  it('writes no ::text cast on an enum', () => {
    const sql = toWhereSql(
      { field: 'affiliation', operator: Operator.in, value: ['advocate', 'consultant'] },
      { columns: { affiliation }, dialect: 'mysql', ...set, model: 'BrandReferenceRequestFanUser' },
    );
    expect(sql).toBe(`${affiliation} IN ('advocate', 'consultant')`);
  });

  it('escapes backslash and single quote', () => {
    expect(mysql({ field: 'field', operator: Operator.equals, value: "O'Brien \\ x\\'" })).toBe(
      "c = 'O''Brien \\\\ x\\\\'''",
    );
  });

  it('composes all / any and the boolean conditions', () => {
    expect(
      mysql({
        any: [
          { field: 'field', operator: Operator.exists },
          { all: [{ field: 'field', operator: Operator.notExists }, true] },
        ],
      }),
    ).toBe('(c IS NOT NULL OR (c IS NULL AND TRUE))');
    expect(mysql({ all: [] })).toBe('TRUE');
    expect(mysql({ any: [] })).toBe('FALSE');
  });

  it('reads a to-one relation’s existence from columns[<rel>.<key>]', () => {
    const options = {
      columns: { 'request.id': '${brand_reference_request.id}' },
      dialect: 'mysql' as const,
      ...set,
      model: 'BrandReferenceRequestFanUser',
    };
    expect(toWhereSql({ field: 'request', operator: Operator.exists }, options)).toBe(
      '${brand_reference_request.id} IS NOT NULL',
    );
    expect(toWhereSql({ field: 'request', operator: Operator.notExists }, options)).toBe(
      '${brand_reference_request.id} IS NULL',
    );
    expect(() =>
      toWhereSql({ field: 'request', operator: Operator.equals, value: 'x' }, options),
    ).toThrow("'request' is a relation");
  });

  it('reads a path through a to-one relation from columns as written', () => {
    expect(
      toWhereSql(
        { field: 'request.status', operator: Operator.equals, value: 'open' },
        {
          columns: { 'request.status': 'r.status' },
          dialect: 'mysql',
          ...set,
          model: 'BrandReferenceRequestFanUser',
        },
      ),
    ).toBe("r.status = 'open'");
  });
});

describe('toWhereSql — refusals', () => {
  it('throws for a path missing from columns, naming it', () => {
    expect(() => mysql({ field: 'other', operator: Operator.equals, value: 'a' })).toThrow(
      "no column for 'other'",
    );
    // An inherited key is not a column.
    expect(() => mysql({ field: 'toString', operator: Operator.exists })).toThrow(
      "no column for 'toString'",
    );
  });

  it('throws for each operator outside the set, naming it', () => {
    for (const operator of [
      Operator.contains,
      Operator.notContains,
      Operator.startsWith,
      Operator.endsWith,
      Operator.matches,
      Operator.notMatches,
      Operator.lessThan,
      Operator.greaterThan,
      Operator.between,
      Operator.isEmpty,
    ])
      expect(() => mysql({ field: 'field', operator, value: 'a' } as Condition)).toThrow(
        `operator '${operator}'`,
      );
    expect(() =>
      mysql({ field: 'field', dateOperator: DateOperator.before, value: '2026-01-01' }),
    ).toThrow("dateOperator 'before'");
    expect(() =>
      mysql({ field: 'field', arrayOperator: 'any', condition: true } as Condition),
    ).toThrow("arrayOperator 'any'");
    expect(() =>
      mysql({ if: true, then: { field: 'field', operator: Operator.exists } } as Condition),
    ).toThrow('if / then / else');
  });

  it('refuses binds, column paths, case-insensitivity and offsets', () => {
    expect(() => mysql({ field: 'field', operator: Operator.equals, bind: 'x' })).toThrow(
      "bind 'x'",
    );
    expect(() => mysql({ field: 'field', operator: Operator.equals, path: 'other' })).toThrow(
      "the column 'other'",
    );
    expect(() =>
      mysql({ field: 'field', operator: Operator.equals, value: 'a', caseInsensitive: true }),
    ).toThrow('case-insensitive');
  });

  it('refuses dates, Json, lists and to-many hops', () => {
    const options = {
      columns: {
        createdAt: 'x',
        'meta.a': 'x',
        tags: 'x',
        'brandReferenceRequestFanUsers.id': 'x',
      },
      dialect: 'mysql' as const,
      ...set,
      model: 'BrandReferenceRequest',
    };
    expect(() =>
      toWhereSql({ field: 'createdAt', operator: Operator.equals, value: '2026-01-01' }, options),
    ).toThrow("the date 'createdAt'");
    expect(() =>
      toWhereSql({ field: 'meta.a', operator: Operator.equals, value: 'x' }, options),
    ).toThrow("the Json value 'meta.a'");
    expect(() => toWhereSql({ field: 'tags', operator: Operator.exists }, options)).toThrow(
      "the list 'tags'",
    );
    expect(() =>
      toWhereSql(
        { field: 'brandReferenceRequestFanUsers.id', operator: Operator.equals, value: 1 },
        options,
      ),
    ).toThrow('to-many');
  });

  it('refuses a dialect other than mysql', () => {
    expect(() =>
      toWhereSql(true, { columns: {}, dialect: 'postgres' as unknown as 'mysql' }),
    ).toThrow("dialect 'postgres'");
  });
});

describe('toLensWhereSql', () => {
  const narrowing: LensNarrowing = {
    parent: lens,
    root: {
      where: { field: 'status', operator: Operator.notEquals, value: 'draft' },
      relations: { brandReferenceRequestFanUsers: { relations: { request: {} } } },
    },
    mapDefaults: {
      app: {
        models: {
          BrandReferenceRequestFanUser: {
            where: { field: 'affiliation', operator: Operator.equals, value: 'advocate' },
          },
        },
      },
    },
  };
  const columns = {
    status: '${brand_reference_request.status}',
    'brandReferenceRequestFanUsers.affiliation': affiliation,
  };

  it('keys the root where under root and a mapDefaults where by the relation reaching it', () => {
    expect(toLensWhereSql(narrowing, { columns, dialect: 'mysql' })).toEqual({
      root: "(${brand_reference_request.status} <> 'draft' OR ${brand_reference_request.status} IS NULL)",
      relations: { brandReferenceRequestFanUsers: `${affiliation} = 'advocate'` },
    });
  });

  it('reports a lens with no wheres as nothing', () => {
    expect(toLensWhereSql(lens, { columns: {}, dialect: 'mysql' })).toEqual({
      root: null,
      relations: {},
    });
  });

  it('names the full path of a column missing below the root', () => {
    expect(() => toLensWhereSql(narrowing, { columns: { status: 's' }, dialect: 'mysql' })).toThrow(
      "no column for 'brandReferenceRequestFanUsers.affiliation'",
    );
  });
});
