// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Omni names a column ${view.dimension}, as plain text.
import { describe, expect, it } from 'bun:test';
import type { Condition, FieldMapSet, Lens, LensNarrowing } from '../index';
import {
  DateOperator,
  engineGlobals,
  Operator,
  SqlDialect,
  toLensWhereSql,
  toWhereSql,
} from '../index';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      BrandReferenceRequest: {
        fields: {
          id: { kind: 'scalar', type: 'Int' },
          status: { kind: 'scalar', type: 'String' },
          score: { kind: 'scalar', type: 'Int' },
          num: { kind: 'scalar', type: 'Float' },
          active: { kind: 'scalar', type: 'Boolean' },
          createdAt: { kind: 'scalar', type: 'DateTime' },
          deletedAt: { kind: 'scalar', type: 'DateTime' },
          meta: { kind: 'scalar', type: 'Json' },
          tags: { kind: 'scalar', type: 'String', isList: true },
          toString: { kind: 'scalar' as const, type: 'String' },
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
const request = { ...set, model: 'BrandReferenceRequest' };
const participant = { ...set, model: 'BrandReferenceRequestFanUser' };
const affiliation = '${brand_reference_request_fan_user.affiliation}';

const onMysql = <T>(fn: () => T): T =>
  engineGlobals.with({ sql: { dialect: SqlDialect.mysql } }, fn);

/** A rule on the request's `status`, read as column `c`, under the MySQL dialect. */
const mysql = (condition: Condition, columns: Record<string, string> = { status: 'c' }) =>
  onMysql(() => toWhereSql(condition, { columns, ...request }));

describe('SqlDialect', () => {
  it('names the SQL dialects, shared by every SQL-writing function', () => {
    expect(SqlDialect).toEqual({ postgres: 'postgres', mysql: 'mysql' });
  });

  it('is an engine global that defaults to postgres', () => {
    expect(engineGlobals.get('sql.dialect')).toBe(SqlDialect.postgres);
  });

  it('refuses a dialect the engine does not know', () => {
    expect(() =>
      engineGlobals.with({ sql: { dialect: 'oracle' as never } }, () =>
        toWhereSql(true, { columns: {}, ...request }),
      ),
    ).toThrow("sql.dialect 'oracle'");
  });
});

describe('toWhereSql — MySQL forms', () => {
  it('writes equals against the caller column, value inline, no joins', () => {
    expect(
      onMysql(() =>
        toWhereSql(
          { field: 'affiliation', operator: Operator.equals, value: 'advocate' },
          { columns: { affiliation }, ...participant },
        ),
      ),
    ).toBe(`${affiliation} = 'advocate'`);
  });

  it('writes in as IN (…) and keeps NULL rows on negations', () => {
    expect(mysql({ field: 'status', operator: Operator.in, value: ['a', 'b'] })).toBe(
      "c IN ('a', 'b')",
    );
    expect(mysql({ field: 'status', operator: Operator.notIn, value: ['a', 'b'] })).toBe(
      "(c NOT IN ('a', 'b') OR c IS NULL)",
    );
    expect(mysql({ field: 'status', operator: Operator.notEquals, value: 'a' })).toBe(
      "(c <> 'a' OR c IS NULL)",
    );
  });

  it('reads a null member and an empty list as check() does', () => {
    expect(mysql({ field: 'status', operator: Operator.in, value: ['a', null] })).toBe(
      "(c IN ('a') OR c IS NULL)",
    );
    expect(mysql({ field: 'status', operator: Operator.notIn, value: ['a', null] })).toBe(
      "(c NOT IN ('a') AND c IS NOT NULL)",
    );
    expect(mysql({ field: 'status', operator: Operator.in, value: [] })).toBe('FALSE');
    expect(mysql({ field: 'status', operator: Operator.notIn, value: [] })).toBe('TRUE');
    expect(mysql({ field: 'status', operator: Operator.equals, value: null })).toBe('c IS NULL');
    expect(mysql({ field: 'status', operator: Operator.notEquals, value: null })).toBe(
      'c IS NOT NULL',
    );
  });

  it('writes numbers and booleans as literals', () => {
    const columns = { num: 'c', active: 'c' };
    expect(mysql({ field: 'num', operator: Operator.in, value: [1, 2.5] }, columns)).toBe(
      'c IN (1, 2.5)',
    );
    expect(mysql({ field: 'active', operator: Operator.equals, value: true }, columns)).toBe(
      'c = TRUE',
    );
  });

  it('writes no ::text cast on an enum', () => {
    const sql = onMysql(() =>
      toWhereSql(
        { field: 'affiliation', operator: Operator.in, value: ['advocate', 'consultant'] },
        { columns: { affiliation }, ...participant },
      ),
    );
    expect(sql).toBe(`${affiliation} IN ('advocate', 'consultant')`);
  });

  it('escapes backslash and single quote', () => {
    expect(mysql({ field: 'status', operator: Operator.equals, value: "O'Brien \\ x\\'" })).toBe(
      "c = 'O''Brien \\\\ x\\\\'''",
    );
  });

  it('composes all / any and the boolean conditions', () => {
    expect(
      mysql({
        any: [
          { field: 'status', operator: Operator.exists },
          { all: [{ field: 'status', operator: Operator.notExists }, true] },
        ],
      }),
    ).toBe('(c IS NOT NULL OR (c IS NULL AND TRUE))');
    expect(mysql({ all: [] })).toBe('TRUE');
    expect(mysql({ any: [] })).toBe('FALSE');
  });

  it('reads a to-one relation’s existence from columns[<rel>.<key>]', () => {
    const options = { columns: { 'request.id': '${brand_reference_request.id}' }, ...participant };
    expect(
      onMysql(() => toWhereSql({ field: 'request', operator: Operator.exists }, options)),
    ).toBe('${brand_reference_request.id} IS NOT NULL');
    expect(
      onMysql(() => toWhereSql({ field: 'request', operator: Operator.notExists }, options)),
    ).toBe('${brand_reference_request.id} IS NULL');
    expect(() =>
      onMysql(() =>
        toWhereSql({ field: 'request', operator: Operator.equals, value: 'x' }, options),
      ),
    ).toThrow("'request' is a relation");
  });

  it('reads a path through a to-one relation from columns as written', () => {
    expect(
      onMysql(() =>
        toWhereSql(
          { field: 'request.status', operator: Operator.equals, value: 'open' },
          { columns: { 'request.status': 'r.status' }, ...participant },
        ),
      ),
    ).toBe("r.status = 'open'");
  });
});

describe('toWhereSql — the Postgres default', () => {
  it('writes the same predicate, escaping only the quote', () => {
    expect(
      toWhereSql(
        { field: 'status', operator: Operator.equals, value: "O'Brien \\ x" },
        { columns: { status: 'c' }, ...request },
      ),
    ).toBe("c = 'O''Brien \\ x'");
    expect(
      toWhereSql(
        { field: 'status', operator: Operator.notIn, value: ['a', 'b'] },
        { columns: { status: 'c' }, ...request },
      ),
    ).toBe("(c NOT IN ('a', 'b') OR c IS NULL)");
  });
});

describe('toWhereSql — existence on every column', () => {
  const columns = {
    deletedAt: '${brand_reference_request.deleted_at}',
    meta: 'm',
    tags: 't',
    'brandReferenceRequestFanUsers.id': 'x',
  };

  it('writes a DateTime’s existence: the lens soft-delete where', () => {
    expect(mysql({ field: 'deletedAt', operator: Operator.notExists }, columns)).toBe(
      '${brand_reference_request.deleted_at} IS NULL',
    );
    expect(mysql({ field: 'deletedAt', operator: Operator.exists }, columns)).toBe(
      '${brand_reference_request.deleted_at} IS NOT NULL',
    );
    expect(mysql({ field: 'deletedAt', operator: Operator.equals, value: null }, columns)).toBe(
      '${brand_reference_request.deleted_at} IS NULL',
    );
  });

  it('writes a list’s existence, and refuses a Json column’s: a JSON null is not a SQL NULL', () => {
    expect(mysql({ field: 'tags', operator: Operator.notExists }, columns)).toBe('t IS NULL');
    expect(() => mysql({ field: 'meta', operator: Operator.exists }, columns)).toThrow(
      "the Json value 'meta'",
    );
    expect(() => mysql({ field: 'meta', operator: Operator.notExists }, columns)).toThrow(
      "the Json value 'meta'",
    );
  });

  it('throws for a rule with no value, as check() does, instead of a NULL test', () => {
    for (const operator of [Operator.equals, Operator.notEquals, Operator.in, Operator.notIn])
      expect(() => mysql({ field: 'status', operator } as Condition)).toThrow(
        'No value, path or bind specified',
      );
  });

  it('still refuses a value compare on a date, Json or list, and any to-many hop', () => {
    expect(() =>
      mysql({ field: 'deletedAt', operator: Operator.equals, value: '2026-01-01' }, columns),
    ).toThrow("the date 'deletedAt'");
    expect(() => mysql({ field: 'meta', operator: Operator.equals, value: 'x' }, columns)).toThrow(
      "the Json value 'meta'",
    );
    expect(() => mysql({ field: 'tags', operator: Operator.in, value: ['x'] }, columns)).toThrow(
      "the list 'tags'",
    );
    expect(() =>
      mysql({ field: 'brandReferenceRequestFanUsers', operator: Operator.exists }, columns),
    ).toThrow("the list 'brandReferenceRequestFanUsers'");
    expect(() =>
      mysql(
        { field: 'brandReferenceRequestFanUsers.id', operator: Operator.equals, value: 1 },
        columns,
      ),
    ).toThrow('to-many');
    expect(() => mysql({ field: 'meta.a', operator: Operator.exists }, { 'meta.a': 'x' })).toThrow(
      "the Json value 'meta.a'",
    );
  });
});

describe('toWhereSql — a value of another type is refused, not cast', () => {
  const columns = { score: 'c', active: 'c', status: 'c', affiliation: 'c' };

  it('refuses a boolean on an Int and a number on a Boolean', () => {
    expect(() =>
      mysql({ field: 'score', operator: Operator.equals, value: true }, columns),
    ).toThrow("value true does not fit Int field 'score'");
    expect(() =>
      mysql({ field: 'score', operator: Operator.in, value: [1, true] }, columns),
    ).toThrow("value true does not fit Int field 'score'");
    expect(() => mysql({ field: 'active', operator: Operator.in, value: [1] }, columns)).toThrow(
      "value 1 does not fit Boolean field 'active'",
    );
  });

  it('refuses a number on an enum and on a String', () => {
    expect(() =>
      onMysql(() =>
        toWhereSql(
          { field: 'affiliation', operator: Operator.equals, value: 1 },
          { columns, ...participant },
        ),
      ),
    ).toThrow("value 1 does not fit Enum field 'affiliation'");
    expect(() => mysql({ field: 'status', operator: Operator.equals, value: 0 }, columns)).toThrow(
      "value 0 does not fit String field 'status'",
    );
  });
});

describe('toWhereSql — refusals', () => {
  it('requires the map and the model, and a model the map declares', () => {
    expect(() => toWhereSql(true, { columns: {} } as never)).toThrow(
      'toWhereSql: `map` and `model` are required',
    );
    expect(() => toWhereSql(true, { columns: {}, ...set } as never)).toThrow(
      'toWhereSql: `map` and `model` are required',
    );
    expect(() => toWhereSql(true, { columns: {}, ...set, model: 'Nope' })).toThrow(
      "toWhereSql: the map has no model 'Nope'",
    );
  });

  it('names itself in the map errors', () => {
    expect(() => toWhereSql(true, { columns: {}, map: { maps }, model: 'X' })).toThrow(
      "toWhereSql: 'map' is a FieldMapSet",
    );
  });

  it('throws for a path missing from columns, naming it', () => {
    expect(() => mysql({ field: 'score', operator: Operator.equals, value: 1 })).toThrow(
      "no column for 'score'",
    );
    // An inherited key is not a column.
    expect(() => mysql({ field: 'toString', operator: Operator.exists })).toThrow(
      "no column for 'toString'",
    );
  });

  it('refuses a path the map does not declare', () => {
    expect(() => mysql({ field: 'other', operator: Operator.equals, value: 'a' })).toThrow(
      "'other' is not a field the map declares on BrandReferenceRequest",
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
      expect(() => mysql({ field: 'status', operator, value: 'a' } as Condition)).toThrow(
        `operator '${operator}'`,
      );
    expect(() =>
      mysql({ field: 'createdAt', dateOperator: DateOperator.before, value: '2026-01-01' }),
    ).toThrow("dateOperator 'before'");
    expect(() =>
      mysql({ field: 'status', arrayOperator: 'any', condition: true } as Condition),
    ).toThrow("arrayOperator 'any'");
    expect(() =>
      mysql({ if: true, then: { field: 'status', operator: Operator.exists } } as Condition),
    ).toThrow('if / then / else');
  });

  it('refuses binds, column paths, case-insensitivity and offsets', () => {
    expect(() => mysql({ field: 'status', operator: Operator.equals, bind: 'x' })).toThrow(
      "bind 'x'",
    );
    expect(() => mysql({ field: 'status', operator: Operator.equals, path: 'other' })).toThrow(
      "the column 'other'",
    );
    expect(() =>
      mysql({ field: 'status', operator: Operator.equals, value: 'a', caseInsensitive: true }),
    ).toThrow('case-insensitive');
  });
});

describe('toLensWhereSql', () => {
  const narrowing: LensNarrowing = {
    parent: lens,
    root: {
      where: {
        all: [
          { field: 'status', operator: Operator.notEquals, value: 'draft' },
          { field: 'deletedAt', operator: Operator.notExists },
        ],
      },
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
    deletedAt: '${brand_reference_request.deleted_at}',
    'brandReferenceRequestFanUsers.affiliation': affiliation,
  };

  it('keys the root where under root and a mapDefaults where by the relation reaching it', () => {
    expect(onMysql(() => toLensWhereSql(narrowing, { columns }))).toEqual({
      root: "((${brand_reference_request.status} <> 'draft' OR ${brand_reference_request.status} IS NULL) AND ${brand_reference_request.deleted_at} IS NULL)",
      relations: { brandReferenceRequestFanUsers: `${affiliation} = 'advocate'` },
    });
  });

  it('reports a lens with no wheres as nothing', () => {
    expect(toLensWhereSql(lens, { columns: {} })).toEqual({ root: null, relations: {} });
  });

  it('names the full path of a column missing below the root', () => {
    expect(() =>
      onMysql(() => toLensWhereSql(narrowing, { columns: { status: 's', deletedAt: 'd' } })),
    ).toThrow("no column for 'brandReferenceRequestFanUsers.affiliation'");
  });
});
